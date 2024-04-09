/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { CodewhispererCodeScanIssueApplyFix, Component, telemetry } from '../../shared/telemetry/telemetry'
import { ExtContext, VSCODE_EXTENSION_ID } from '../../shared/extensions'
import { Commands, VsCodeCommandArg } from '../../shared/vscode/commands2'
import * as CodeWhispererConstants from '../models/constants'
import { DefaultCodeWhispererClient } from '../client/codewhisperer'
import { startSecurityScanWithProgress, confirmStopSecurityScan } from './startSecurityScan'
import { SecurityPanelViewProvider } from '../views/securityPanelViewProvider'
import { CodeScanIssue, codeScanState, CodeSuggestionsState, vsCodeState } from '../models/model'
import { connectToEnterpriseSso, getStartUrl } from '../util/getStartUrl'
import { showCodeWhispererConnectionPrompt } from '../util/showSsoPrompt'
import { ReferenceLogViewProvider } from '../service/referenceLogViewProvider'
import { AuthUtil, refreshToolkitQState } from '../util/authUtil'
import { isCloud9 } from '../../shared/extensionUtilities'
import { getLogger } from '../../shared/logger'
import { isExtensionInstalled, openUrl } from '../../shared/utilities/vsCodeUtils'
import {
    getPersistedCustomizations,
    notifyNewCustomizations,
    selectCustomization,
    showCustomizationPrompt,
} from '../util/customizationUtil'
import { applyPatch } from 'diff'
import { closeSecurityIssueWebview, showSecurityIssueWebview } from '../views/securityIssue/securityIssueWebview'
import { fsCommon } from '../../srcShared/fs'
import { Mutable } from '../../shared/utilities/tsUtils'
import { CodeWhispererSource } from './types'
import { FeatureConfigProvider } from '../service/featureConfigProvider'
import { TelemetryHelper } from '../util/telemetryHelper'
import { Auth, AwsConnection } from '../../auth'
import { once } from '../../shared/utilities/functionUtils'
import { isTextEditor } from '../../shared/utilities/editorUtilities'
import { globals } from '../../shared'
import { randomUUID } from 'crypto'

export const toggleCodeSuggestions = Commands.declare(
    { id: 'aws.codeWhisperer.toggleCodeSuggestion', compositeKey: { 1: 'source' } },
    (suggestionState: CodeSuggestionsState) => async (_: VsCodeCommandArg, source: CodeWhispererSource) => {
        await telemetry.aws_modifySetting.run(async span => {
            span.record({
                settingId: CodeWhispererConstants.autoSuggestionConfig.settingId,
            })

            const isSuggestionsEnabled = await suggestionState.toggleSuggestions()
            span.record({
                settingState: isSuggestionsEnabled
                    ? CodeWhispererConstants.autoSuggestionConfig.activated
                    : CodeWhispererConstants.autoSuggestionConfig.deactivated,
            })
            vsCodeState.isFreeTierLimitReached = false
        })
    }
)

export const enableCodeSuggestions = Commands.declare(
    'aws.codeWhisperer.enableCodeSuggestions',
    (context: ExtContext) =>
        async (isAuto: boolean = true) => {
            await CodeSuggestionsState.instance.setSuggestionsEnabled(isAuto)
            await vscode.commands.executeCommand('setContext', 'aws.codewhisperer.connected', true)
            await vscode.commands.executeCommand('setContext', 'aws.codewhisperer.connectionExpired', false)
            vsCodeState.isFreeTierLimitReached = false
            if (!isCloud9()) {
                await vscode.commands.executeCommand('aws.codeWhisperer.refreshStatusBar')
            }
        }
)

export const showReferenceLog = Commands.declare(
    { id: 'aws.codeWhisperer.openReferencePanel', compositeKey: { 1: 'source' } },
    () => async (_: VsCodeCommandArg, source: CodeWhispererSource) => {
        await vscode.commands.executeCommand('workbench.view.extension.aws-codewhisperer-reference-log')
    }
)

export const showIntroduction = Commands.declare('aws.codeWhisperer.introduction', () => async () => {
    void openUrl(vscode.Uri.parse(CodeWhispererConstants.learnMoreUriGeneral))
})

export const showSecurityScan = Commands.declare(
    { id: 'aws.codeWhisperer.security.scan', compositeKey: { 1: 'source' } },
    (context: ExtContext, securityPanelViewProvider: SecurityPanelViewProvider, client: DefaultCodeWhispererClient) =>
        async (_: VsCodeCommandArg, source: CodeWhispererSource) => {
            if (AuthUtil.instance.isConnectionExpired()) {
                await AuthUtil.instance.notifyReauthenticate()
            }
            const editor = vscode.window.activeTextEditor
            if (editor && isTextEditor(editor)) {
                if (codeScanState.isNotStarted()) {
                    // User intends to start as "Start Security Scan" is shown in the explorer tree
                    codeScanState.setToRunning()
                    void startSecurityScanWithProgress(
                        securityPanelViewProvider,
                        editor,
                        client,
                        context.extensionContext
                    )
                } else if (codeScanState.isRunning()) {
                    // User intends to stop as "Stop Security Scan" is shown in the explorer tree
                    // Cancel only when the code scan state is "Running"
                    await confirmStopSecurityScan()
                }
                vsCodeState.isFreeTierLimitReached = false
            } else {
                void vscode.window.showInformationMessage('Open a valid file to scan.')
            }
        }
)

export const selectCustomizationPrompt = Commands.declare(
    { id: 'aws.codeWhisperer.selectCustomization', compositeKey: { 1: 'source' } },
    () => async (_: VsCodeCommandArg, source: CodeWhispererSource) => {
        telemetry.ui_click.emit({ elementId: 'cw_selectCustomization_Cta' })
        void showCustomizationPrompt().then()
    }
)

export const reconnect = Commands.declare(
    { id: 'aws.codewhisperer.reconnect', compositeKey: { 1: 'source' } },
    () =>
        async (_: VsCodeCommandArg, source: CodeWhispererSource, addMissingScopes: boolean = false) => {
            if (typeof addMissingScopes !== 'boolean') {
                addMissingScopes = false
            }
            await AuthUtil.instance.reauthenticate(addMissingScopes)
        }
)

/** @deprecated in favor of the `Add Connection` page */
export const showSsoSignIn = Commands.declare('aws.codeWhisperer.sso', () => async () => {
    telemetry.ui_click.emit({ elementId: 'cw_signUp_Cta' })
    await showCodeWhispererConnectionPrompt()
})

// Shortcut command to directly connect to Identity Center or prompt start URL entry
// It can optionally set a customization too based on given values to match on

// This command is only declared and registered in Amazon Q if Q exists
export const connectWithCustomization = Commands.declare(
    { id: 'aws.codeWhisperer.connect', compositeKey: { 0: 'source' } },
    /**
     * This command supports the following arguments:
     * @param source - an identifier for who used this command. This value is not explicitly used in the function, but is used elsewhere.
     * startUrl and region. If both arguments are provided they will be used, otherwise
     *  the command prompts for them interactively.
     * customizationArn: select customization by ARN. If provided, `customizationNamePrefix` is ignored.
     * customizationNamePrefix: select customization by prefix, if `customizationArn` is `undefined`.
     */
    () =>
        async (
            source: string,
            startUrl?: string,
            region?: string,
            customizationArn?: string,
            customizationNamePrefix?: string
        ) => {
            if (startUrl && region) {
                await connectToEnterpriseSso(startUrl, region)
            } else {
                await getStartUrl()
            }

            // No customization match information given, exit early.
            if (!customizationArn && !customizationNamePrefix) {
                return
            }

            let persistedCustomizations = getPersistedCustomizations()

            // Check if any customizations have already been persisted.
            // If not, call `notifyNewCustomizations` to handle it then recheck.
            if (persistedCustomizations.length === 0) {
                await notifyNewCustomizations()
                persistedCustomizations = getPersistedCustomizations()
            }

            // If given an ARN, assume a specific customization is desired and find an entry that matches it. Ignores the prefix logic.
            // Otherwise if only a prefix is given, find an entry that matches it.
            // Backwards compatible with previous implementation.
            const match = customizationArn
                ? persistedCustomizations.find(c => c.arn === customizationArn)
                : persistedCustomizations.find(c => c.name?.startsWith(customizationNamePrefix as string))

            // If no match is found, nothing to do :)
            if (!match) {
                getLogger().error(
                    `No customization match found: arn=${customizationArn} prefix=${customizationNamePrefix}`
                )
                return
            }
            // Since we selected based on a match, we'll reuse the persisted values.
            await selectCustomization(match)
        }
)

export const showLearnMore = Commands.declare(
    { id: 'aws.codeWhisperer.learnMore', compositeKey: { 0: 'source' } },
    () => async (source: CodeWhispererSource) => {
        telemetry.ui_click.emit({ elementId: 'cw_learnMore_Cta' })
        void openUrl(vscode.Uri.parse(CodeWhispererConstants.learnMoreUriGeneral))
    }
)

// TODO: Use a different URI
export const showFreeTierLimit = Commands.declare(
    { id: 'aws.codeWhisperer.freeTierLimit', compositeKey: { 1: 'source' } },
    () => async (_: VsCodeCommandArg, source: CodeWhispererSource) => {
        void openUrl(vscode.Uri.parse(CodeWhispererConstants.learnMoreUri))
    }
)

export const updateReferenceLog = Commands.declare(
    {
        id: 'aws.codeWhisperer.updateReferenceLog',
        logging: false,
    },
    () => () => {
        ReferenceLogViewProvider.instance.update()
    }
)

export const openSecurityIssuePanel = Commands.declare(
    'aws.codeWhisperer.openSecurityIssuePanel',
    (context: ExtContext) => async (issue: CodeScanIssue, filePath: string) => {
        await showSecurityIssueWebview(context.extensionContext, issue, filePath)

        telemetry.codewhisperer_codeScanIssueViewDetails.emit({
            findingId: issue.findingId,
            detectorId: issue.detectorId,
            ruleId: issue.ruleId,
            credentialStartUrl: AuthUtil.instance.startUrl,
        })
        TelemetryHelper.instance.sendCodeScanRemediationsEvent(
            undefined,
            'CODESCAN_ISSUE_VIEW_DETAILS',
            issue.detectorId,
            issue.findingId,
            issue.ruleId,
            undefined,
            undefined,
            undefined,
            !!issue.suggestedFixes.length
        )
    }
)

export const notifyNewCustomizationsCmd = Commands.declare(
    { id: 'aws.codeWhisperer.notifyNewCustomizations', logging: false },
    () => () => {
        notifyNewCustomizations().catch(e => {
            getLogger().error('notifyNewCustomizations failed: %s', (e as Error).message)
        })
    }
)

export const fetchFeatureConfigsCmd = Commands.declare(
    { id: 'aws.codeWhisperer.fetchFeatureConfigs', logging: false },
    () => async () => {
        await FeatureConfigProvider.instance.fetchFeatureConfigs()
    }
)

/**
 * Actually install Amazon Q.
 * Sometimes reload VS Code window after installation is necessary
 * to properly activate extension. In that case, VS Code will prompt user to reload.
 */
export const installAmazonQExtension = Commands.declare(
    { id: 'aws.toolkit.installAmazonQExtension', logging: true },
    () => async () => {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', VSCODE_EXTENSION_ID.amazonq)
        // jump to Amazon Q extension view after install.
        // this command won't work without a small delay after install
        setTimeout(() => {
            void vscode.commands.executeCommand('workbench.view.extension.amazonq')
        }, 1000)
    }
)

export const applySecurityFix = Commands.declare(
    'aws.codeWhisperer.applySecurityFix',
    () => async (issue: CodeScanIssue, filePath: string, source: Component) => {
        const [suggestedFix] = issue.suggestedFixes
        if (!suggestedFix || !filePath) {
            return
        }

        const applyFixTelemetryEntry: Mutable<CodewhispererCodeScanIssueApplyFix> = {
            detectorId: issue.detectorId,
            findingId: issue.findingId,
            ruleId: issue.ruleId,
            component: source,
            result: 'Succeeded',
            credentialStartUrl: AuthUtil.instance.startUrl,
        }
        let languageId = undefined
        try {
            const patch = suggestedFix.code
            const document = await vscode.workspace.openTextDocument(filePath)
            const fileContent = document.getText()
            languageId = document.languageId
            const updatedContent = applyPatch(fileContent, patch)
            if (!updatedContent) {
                void vscode.window.showErrorMessage(CodeWhispererConstants.codeFixAppliedFailedMessage)
                throw Error('Failed to get updated content from applying diff patch')
            }

            // saving the document text if not save
            const isSaved = await document.save()
            if (!isSaved) {
                throw Error('Failed to save editor text changes into the file.')
            }

            // writing the patch applied version of document into the file
            await fsCommon.writeFile(filePath, updatedContent)
            void vscode.window
                .showInformationMessage(CodeWhispererConstants.codeFixAppliedSuccessMessage, {
                    title: CodeWhispererConstants.runSecurityScanButtonTitle,
                })
                .then(res => {
                    if (res?.title === CodeWhispererConstants.runSecurityScanButtonTitle) {
                        void vscode.commands.executeCommand('aws.codeWhisperer.security.scan')
                    }
                })
            await closeSecurityIssueWebview(issue.findingId)
        } catch (err) {
            getLogger().error(`Apply fix command failed. ${err}`)
            applyFixTelemetryEntry.result = 'Failed'
            applyFixTelemetryEntry.reason = err as string
        } finally {
            telemetry.codewhisperer_codeScanIssueApplyFix.emit(applyFixTelemetryEntry)
            TelemetryHelper.instance.sendCodeScanRemediationsEvent(
                languageId,
                'CODESCAN_ISSUE_APPLY_FIX',
                issue.detectorId,
                issue.findingId,
                issue.ruleId,
                source,
                applyFixTelemetryEntry.reason,
                applyFixTelemetryEntry.result,
                !!issue.suggestedFixes.length
            )
        }
    }
)

export const signoutCodeWhisperer = Commands.declare(
    { id: 'aws.codewhisperer.signout', compositeKey: { 1: 'source' } },
    (auth: AuthUtil) => (_: VsCodeCommandArg, source: CodeWhispererSource) => {
        return auth.secondaryAuth.deleteConnection()
    }
)

let _toolkitApi: any = undefined

const registerToolkitApiCallbackOnce = once(async () => {
    getLogger().info(`toolkitApi: Registering callbacks of toolkit api`)
    const auth = Auth.instance

    auth.onDidChangeConnectionState(async e => {
        // when changing connection state in Q, also change connection state in toolkit
        if (_toolkitApi && 'setConnection' in _toolkitApi) {
            const id = e.id
            const conn = await auth.getConnection({ id })
            if (conn && conn.type === 'sso') {
                getLogger().info(`toolkitApi: set connection ${id}`)
                await _toolkitApi.setConnection({
                    type: conn.type,
                    ssoRegion: conn.ssoRegion,
                    scopes: conn.scopes,
                    startUrl: conn.startUrl,
                    state: e.state,
                    id: id,
                    label: conn.label,
                } as AwsConnection)
            }
        }
    })
    // when deleting connection in Q, also delete same connection in toolkit
    auth.onDidDeleteConnection(async id => {
        if (_toolkitApi && 'deleteConnection' in _toolkitApi) {
            getLogger().info(`toolkitApi: delete connection ${id}`)
            await _toolkitApi.deleteConnection(id)
        }
    })

    // when toolkit connection changes
    if (_toolkitApi && 'onDidChangeConnection' in _toolkitApi) {
        _toolkitApi.onDidChangeConnection(
            async (connection: AwsConnection) => {
                getLogger().info(`toolkitApi: connection change callback ${connection.id}`)
                await AuthUtil.instance.onUpdateConnection(connection)
                // If the connection was properly updated, then calling this with (true) shouldn't
                // trigger an event. But, just to be safe...
                await refreshToolkitQState.execute(false)
            },

            async (id: string) => {
                getLogger().info(`toolkitApi: connection delete callback ${id}`)
                await AuthUtil.instance.onDeleteConnection(id)
                await refreshToolkitQState.execute(false)
            }
        )
    }

    // when toolkit activate i
    if (_toolkitApi && 'onX' in _toolkitApi) {
        const clientId = globals.context.globalState.get<string>('telemetryClientId')
        _toolkitApi.onX(clientId)
    }
})
export const registerToolkitApiCallback = Commands.declare(
    { id: 'aws.amazonq.refreshConnectionCallback' },
    () => async (toolkitApi?: any) => {
        // While the Q/CW exposes an API for the Toolkit to register callbacks on auth changes,
        // we need to do it manually here because the Toolkit would have been unable to call
        // this API if the Q/CW extension started afterwards (and this code block is running).
        if (isExtensionInstalled(VSCODE_EXTENSION_ID.awstoolkit)) {
            getLogger().info(`Trying to register toolkit callback. Toolkit is installed.`)
            if (toolkitApi) {
                // when this command is executed by AWS Toolkit activation
                _toolkitApi = toolkitApi.getApi(VSCODE_EXTENSION_ID.amazonq)
            } else {
                // when this command is executed by Amazon Q activation
                const toolkitExt = vscode.extensions.getExtension(VSCODE_EXTENSION_ID.awstoolkit)
                _toolkitApi = toolkitExt?.exports.getApi(VSCODE_EXTENSION_ID.amazonq)
            }
            if (_toolkitApi) {
                await registerToolkitApiCallbackOnce()
            }
        }
    }
)
// when starting Amazon Q, try to use the existing telemetry client id in AWS toolkit
export const setupAmazonQTelemetryClientId = once(async () => {
    if (isExtensionInstalled(VSCODE_EXTENSION_ID.awstoolkit)) {
        const toolkitExt = vscode.extensions.getExtension(VSCODE_EXTENSION_ID.awstoolkit)
        const _toolkitApi = toolkitExt?.exports.getApi(VSCODE_EXTENSION_ID.amazonq)
        let clientId: string | undefined = undefined
        if (_toolkitApi && 'getTelemetryClientId' in _toolkitApi) {
            clientId = await _toolkitApi.getTelemetryClientId()
        }
        if (!clientId) {
            clientId = randomUUID()
        }
        await globals.extensionContext.globalStates.update('telemetryClientId', clientId)
    }
})
