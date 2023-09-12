/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { extensionVersion } from '../../shared/vscode/env'
import { RecommendationsList, DefaultCodeWhispererClient, CognitoCredentialsError } from '../client/codewhisperer'
import * as EditorContext from '../util/editorContext'
import * as CodeWhispererConstants from '../models/constants'
import { ConfigurationEntry, GetRecommendationsResponse, vsCodeState } from '../models/model'
import { runtimeLanguageContext } from '../util/runtimeLanguageContext'
import { AWSError } from 'aws-sdk'
import { isAwsError } from '../../shared/errors'
import { TelemetryHelper } from '../util/telemetryHelper'
import { getLogger } from '../../shared/logger'
import { isCloud9 } from '../../shared/extensionUtilities'
import {
    asyncCallWithTimeout,
    isInlineCompletionEnabled,
    isVscHavingRegressionInlineCompletionApi,
} from '../util/commonUtil'
import { showTimedMessage } from '../../shared/utilities/messages'
import {
    CodewhispererAutomatedTriggerType,
    CodewhispererCompletionType,
    CodewhispererTriggerType,
    telemetry,
} from '../../shared/telemetry/telemetry'
import { CodeWhispererCodeCoverageTracker } from '../tracker/codewhispererCodeCoverageTracker'
import { session } from '../util/codeWhispererSession'
import { Commands } from '../../shared/vscode/commands2'
import globals from '../../shared/extensionGlobals'
import { noSuggestions, updateInlineLockKey } from '../models/constants'
import AsyncLock from 'async-lock'
import { AuthUtil } from '../util/authUtil'
import { CodeWhispererUserGroupSettings } from '../util/userGroupUtil'
import { CWInlineCompletionItemProvider } from './inlineCompletionItemProvider'
import { application } from '../util/codeWhispererApplication'

/**
 * This class is for getRecommendation/listRecommendation API calls and its states
 * It does not contain UI/UX related logic
 */

const performance = globalThis.performance ?? require('perf_hooks').performance

// below commands override VS Code inline completion commands
const prevCommand = Commands.declare('editor.action.inlineSuggest.showPrevious', () => async () => {
    await RecommendationHandler.instance.showRecommendation(-1)
})
const nextCommand = Commands.declare('editor.action.inlineSuggest.showNext', () => async () => {
    await RecommendationHandler.instance.showRecommendation(1)
})

const rejectCommand = Commands.declare('aws.codeWhisperer.rejectCodeSuggestion', () => async () => {
    RecommendationHandler.instance.reportUserDecisions(-1)
})

const lock = new AsyncLock({ maxPending: 1 })

export class RecommendationHandler {
    public lastInvocationTime: number
    public requestId: string
    private nextToken: string
    private cancellationToken: vscode.CancellationTokenSource
    public isGenerateRecommendationInProgress: boolean
    private _onDidReceiveRecommendation: vscode.EventEmitter<void> = new vscode.EventEmitter<void>()
    public readonly onDidReceiveRecommendation: vscode.Event<void> = this._onDidReceiveRecommendation.event
    private inlineCompletionProvider?: CWInlineCompletionItemProvider
    private inlineCompletionProviderDisposable?: vscode.Disposable
    private reject: vscode.Disposable
    private next: vscode.Disposable
    private prev: vscode.Disposable
    private _timer?: NodeJS.Timer
    documentUri: vscode.Uri | undefined = undefined

    constructor() {
        this.requestId = ''
        this.nextToken = ''
        this.lastInvocationTime = performance.now() - CodeWhispererConstants.invocationTimeIntervalThreshold * 1000
        this.cancellationToken = new vscode.CancellationTokenSource()
        this.isGenerateRecommendationInProgress = false
        this.prev = new vscode.Disposable(() => {})
        this.next = new vscode.Disposable(() => {})
        this.reject = new vscode.Disposable(() => {})
    }

    static #instance: RecommendationHandler

    public static get instance() {
        return (this.#instance ??= new this())
    }

    isValidResponse(): boolean {
        return (
            session.recommendations !== undefined &&
            session.recommendations.length > 0 &&
            session.recommendations.filter(option => option.content.length > 0).length > 0
        )
    }

    async getServerResponse(
        triggerType: CodewhispererTriggerType,
        isManualTriggerOn: boolean,
        isFirstPaginationCall: boolean,
        promise: Promise<any>
    ): Promise<any> {
        const timeoutMessage = isCloud9() ? `Generate recommendation timeout.` : `List recommendation timeout`
        try {
            if (isManualTriggerOn && triggerType === 'OnDemand' && (isCloud9() || isFirstPaginationCall)) {
                return vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: CodeWhispererConstants.pendingResponse,
                        cancellable: false,
                    },
                    async () => {
                        return await asyncCallWithTimeout(
                            promise,
                            timeoutMessage,
                            CodeWhispererConstants.promiseTimeoutLimit * 1000
                        )
                    }
                )
            }
            return await asyncCallWithTimeout(
                promise,
                timeoutMessage,
                CodeWhispererConstants.promiseTimeoutLimit * 1000
            )
        } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : error}`)
        }
    }

    async getRecommendations(
        client: DefaultCodeWhispererClient,
        editor: vscode.TextEditor,
        triggerType: CodewhispererTriggerType,
        config: ConfigurationEntry,
        autoTriggerType?: CodewhispererAutomatedTriggerType,
        pagination: boolean = true,
        page: number = 0
    ): Promise<GetRecommendationsResponse> {
        let invocationResult: 'Succeeded' | 'Failed' = 'Failed'
        let errorMessage: string | undefined = undefined

        if (!editor) {
            return Promise.resolve<GetRecommendationsResponse>({
                result: invocationResult,
                errorMessage: errorMessage,
            })
        }
        let recommendations: RecommendationsList = []
        let requestId = ''
        let sessionId = ''
        let reason = ''
        let startTime = 0
        let latency = 0
        let nextToken = ''
        let shouldRecordServiceInvocation = true
        session.language = runtimeLanguageContext.getLanguageContext(editor.document.languageId).language

        if (pagination) {
            if (page === 0) {
                session.requestContext = await EditorContext.buildListRecommendationRequest(
                    editor as vscode.TextEditor,
                    this.nextToken,
                    config.isSuggestionsWithCodeReferencesEnabled
                )
            } else {
                session.requestContext = {
                    request: {
                        fileContext: session.requestContext.request.fileContext,
                        nextToken: this.nextToken,
                        supplementalContexts: session.requestContext.request.supplementalContexts,
                    },
                    supplementalMetadata: session.requestContext.supplementalMetadata,
                }
            }
        } else if (!pagination) {
            session.requestContext = await EditorContext.buildGenerateRecommendationRequest(editor as vscode.TextEditor)
        }
        const request = session.requestContext.request

        // set start pos for non pagination call or first pagination call
        if (!pagination || (pagination && page === 0)) {
            session.startPos = editor.selection.active
            session.leftContextOfCurrentLine = EditorContext.getLeftContext(editor, session.startPos.line)

            /**
             * Validate request
             */
            if (!EditorContext.validateRequest(request)) {
                getLogger().verbose(
                    'Invalid Request : ',
                    JSON.stringify(request, undefined, EditorContext.getTabSize())
                )
                const languageName = request.fileContext.programmingLanguage.languageName
                if (!runtimeLanguageContext.isLanguageSupported(languageName)) {
                    errorMessage = `${languageName} is currently not supported by CodeWhisperer`
                }
                return Promise.resolve<GetRecommendationsResponse>({
                    result: invocationResult,
                    errorMessage: errorMessage,
                })
            }
        }

        try {
            startTime = performance.now()
            this.lastInvocationTime = startTime
            const mappedReq = runtimeLanguageContext.mapToRuntimeLanguage(request)
            const codewhispererPromise = pagination
                ? client.listRecommendations(mappedReq)
                : client.generateRecommendations(mappedReq)
            const resp = await this.getServerResponse(
                triggerType,
                config.isManualTriggerEnabled,
                page === 0,
                codewhispererPromise
            )
            TelemetryHelper.instance.setSdkApiCallEndTime()
            latency = startTime !== 0 ? performance.now() - startTime : 0
            if ('recommendations' in resp) {
                recommendations = (resp && resp.recommendations) || []
            } else {
                recommendations = (resp && resp.completions) || []
            }
            invocationResult = 'Succeeded'
            TelemetryHelper.instance.triggerType = triggerType
            TelemetryHelper.instance.CodeWhispererAutomatedtriggerType =
                autoTriggerType === undefined ? 'KeyStrokeCount' : autoTriggerType
            requestId = resp?.$response && resp?.$response?.requestId
            nextToken = resp?.nextToken ? resp?.nextToken : ''
            sessionId = resp?.$response?.httpResponse?.headers['x-amzn-sessionid']
            TelemetryHelper.instance.setFirstResponseRequestId(requestId)
            if (page === 0) {
                TelemetryHelper.instance.setTimeToFirstRecommendation(performance.now())
            }
            if (nextToken === '') {
                TelemetryHelper.instance.setLastRequestId(requestId)
                TelemetryHelper.instance.setAllPaginationEndTime()
            }
        } catch (error) {
            if (error instanceof CognitoCredentialsError) {
                shouldRecordServiceInvocation = false
            }
            if (latency === 0) {
                latency = startTime !== 0 ? performance.now() - startTime : 0
            }
            getLogger().error('CodeWhisperer Invocation Exception : %s', (error as Error).message)
            if (isAwsError(error)) {
                errorMessage = error.message
                requestId = error.requestId || ''
                reason = `CodeWhisperer Invocation Exception: ${error?.code ?? error?.name ?? 'unknown'}`
                await this.onThrottlingException(error, triggerType)
            } else {
                errorMessage = error as string
                reason = error ? String(error) : 'unknown'
            }
        } finally {
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
            getLogger().debug(
                `Request ID: ${requestId},
                timestamp(epoch): ${Date.now()},
                timezone: ${timezone},
                datetime: ${new Date().toLocaleString([], { timeZone: timezone })},
                vscode version: '${vscode.version}',
                extension version: '${extensionVersion}',
                filename: '${EditorContext.getFileName(editor)}',
                left context of line:  '${session.leftContextOfCurrentLine}',
                line number: ${session.startPos.line},
                character location: ${session.startPos.character},
                latency: ${latency} ms.`
            )
            getLogger().verbose('Recommendations:')
            recommendations.forEach((item, index) => {
                getLogger().verbose(`[${index}]\n${item.content.trimRight()}`)
            })
            if (invocationResult === 'Succeeded') {
                CodeWhispererCodeCoverageTracker.getTracker(session.language)?.incrementServiceInvocationCount()
            }
            if (shouldRecordServiceInvocation) {
                TelemetryHelper.instance.recordServiceInvocationTelemetry(
                    requestId,
                    sessionId,
                    session.recommendations.length + recommendations.length - 1,
                    triggerType,
                    autoTriggerType,
                    invocationResult,
                    latency,
                    session.startPos.line,
                    session.language,
                    reason,
                    session.requestContext.supplementalMetadata
                )
            }
        }

        if (this.isCancellationRequested()) {
            return Promise.resolve<GetRecommendationsResponse>({
                result: invocationResult,
                errorMessage: errorMessage,
            })
        }

        const typedPrefix = editor.document
            .getText(new vscode.Range(session.startPos, editor.selection.active))
            .replace('\r\n', '\n')
        if (recommendations.length > 0) {
            TelemetryHelper.instance.setTypeAheadLength(typedPrefix.length)
            // mark suggestions that does not match typeahead when arrival as Discard
            // these suggestions can be marked as Showed if typeahead can be removed with new inline API
            recommendations.forEach((r, i) => {
                const recommendationIndex = i + session.recommendations.length
                if (
                    !r.content.startsWith(typedPrefix) &&
                    session.getSuggestionState(recommendationIndex) === undefined
                ) {
                    session.setSuggestionState(recommendationIndex, 'Discard')
                }
                session.setCompletionType(recommendationIndex, r)
            })
            session.recommendations = pagination ? session.recommendations.concat(recommendations) : recommendations
            if (isInlineCompletionEnabled() && this.hasAtLeastOneValidSuggestion(typedPrefix)) {
                this._onDidReceiveRecommendation.fire()
            }
        }

        this.requestId = requestId
        session.sessionId = sessionId
        this.nextToken = nextToken

        // send Empty userDecision event if user receives no recommendations in this session at all.
        if (invocationResult === 'Succeeded' && nextToken === '') {
            if (session.recommendations.length === 0) {
                // Received an empty list of recommendations
                TelemetryHelper.instance.recordUserDecisionTelemetryForEmptyList(
                    requestId,
                    sessionId,
                    page,
                    editor.document.languageId,
                    session.requestContext.supplementalMetadata
                )
            }
            if (!this.hasAtLeastOneValidSuggestion(typedPrefix)) {
                this.reportUserDecisions(-1)
            }
        }
        return Promise.resolve<GetRecommendationsResponse>({
            result: invocationResult,
            errorMessage: errorMessage,
        })
    }

    hasAtLeastOneValidSuggestion(typedPrefix: string): boolean {
        return session.recommendations.some(r => r.content.trim() !== '' && r.content.startsWith(typedPrefix))
    }

    cancelPaginatedRequest() {
        this.nextToken = ''
        this.cancellationToken.cancel()
    }

    isCancellationRequested() {
        return this.cancellationToken.token.isCancellationRequested
    }

    checkAndResetCancellationTokens() {
        if (this.isCancellationRequested()) {
            this.cancellationToken.dispose()
            this.cancellationToken = new vscode.CancellationTokenSource()
            this.nextToken = ''
            return true
        }
        return false
    }
    /**
     * Clear recommendation state
     */
    clearRecommendations() {
        session.recommendations = []
        session.suggestionStates = new Map<number, string>()
        session.completionTypes = new Map<number, CodewhispererCompletionType>()
        this.requestId = ''
        session.sessionId = ''
        this.nextToken = ''
        session.requestContext.supplementalMetadata = undefined
    }

    async clearInlineCompletionStates() {
        try {
            vsCodeState.isCodeWhispererEditing = false
            application()._clearCodeWhispererUIListener.fire()
            this.cancelPaginatedRequest()
            this.clearRecommendations()
            this.disposeInlineCompletion()
            await vscode.commands.executeCommand('aws.codeWhisperer.refreshStatusBar')
            this.disposeCommandOverrides()
            // fix a regression that requires user to hit Esc twice to clear inline ghost text
            // because disposing a provider does not clear the UX
            if (isVscHavingRegressionInlineCompletionApi()) {
                await vscode.commands.executeCommand('editor.action.inlineSuggest.hide')
            }
        } finally {
            this.clearRejectionTimer()
        }
    }

    reportDiscardedUserDecisions() {
        session.recommendations.forEach((r, i) => {
            session.setSuggestionState(i, 'Discard')
        })
        this.reportUserDecisions(-1)
    }

    /**
     * Emits telemetry reflecting user decision for current recommendation.
     */
    reportUserDecisions(acceptIndex: number) {
        if (session.sessionId === '' || this.requestId === '') {
            return
        }
        TelemetryHelper.instance.recordUserDecisionTelemetry(
            this.requestId,
            session.sessionId,
            session.recommendations,
            acceptIndex,
            session.recommendations.length,
            session.completionTypes,
            session.suggestionStates,
            session.requestContext.supplementalMetadata
        )
        if (isCloud9('any')) {
            this.clearRecommendations()
        } else if (isInlineCompletionEnabled()) {
            this.clearInlineCompletionStates()
        }
    }

    hasNextToken(): boolean {
        return this.nextToken !== ''
    }

    canShowRecommendationInIntelliSense(
        editor: vscode.TextEditor,
        showPrompt: boolean = false,
        response: GetRecommendationsResponse
    ): boolean {
        const reject = () => {
            this.reportUserDecisions(-1)
        }
        if (!this.isValidResponse()) {
            if (showPrompt) {
                showTimedMessage(response.errorMessage ? response.errorMessage : noSuggestions, 3000)
            }
            reject()
            return false
        }
        // do not show recommendation if cursor is before invocation position
        // also mark as Discard
        if (editor.selection.active.isBefore(session.startPos)) {
            session.recommendations.forEach((r, i) => {
                session.setSuggestionState(i, 'Discard')
            })
            reject()
            return false
        }

        // do not show recommendation if typeahead does not match
        // also mark as Discard
        const typedPrefix = editor.document.getText(
            new vscode.Range(
                session.startPos.line,
                session.startPos.character,
                editor.selection.active.line,
                editor.selection.active.character
            )
        )
        if (!session.recommendations[0].content.startsWith(typedPrefix.trimStart())) {
            session.recommendations.forEach((r, i) => {
                session.setSuggestionState(i, 'Discard')
            })
            reject()
            return false
        }
        return true
    }

    async onThrottlingException(awsError: AWSError, triggerType: CodewhispererTriggerType) {
        if (
            awsError.code === 'ThrottlingException' &&
            awsError.message.includes(CodeWhispererConstants.throttlingMessage)
        ) {
            if (triggerType === 'OnDemand') {
                vscode.window.showErrorMessage(CodeWhispererConstants.freeTierLimitReached)
            }
            await vscode.commands.executeCommand('aws.codeWhisperer.refresh', true)
        }
    }

    public disposeInlineCompletion() {
        this.inlineCompletionProviderDisposable?.dispose()
        this.inlineCompletionProvider = undefined
    }

    private disposeCommandOverrides() {
        this.prev.dispose()
        this.reject.dispose()
        this.next.dispose()
    }

    // These commands override the vs code inline completion commands
    // They are subscribed when suggestion starts and disposed when suggestion is accepted/rejected
    // to avoid impacting other plugins or user who uses this API
    private registerCommandOverrides() {
        this.prev = prevCommand.register()
        this.next = nextCommand.register()
        this.reject = rejectCommand.register()
    }

    subscribeSuggestionCommands() {
        this.disposeCommandOverrides()
        this.registerCommandOverrides()
        globals.context.subscriptions.push(this.prev)
        globals.context.subscriptions.push(this.next)
        globals.context.subscriptions.push(this.reject)
    }

    async showRecommendation(indexShift: number, noSuggestionVisible: boolean = false) {
        await lock.acquire(updateInlineLockKey, async () => {
            if (!vscode.window.state.focused) {
                this.reportDiscardedUserDecisions()
                return
            }
            const inlineCompletionProvider = new CWInlineCompletionItemProvider(
                this.inlineCompletionProvider?.getActiveItemIndex,
                indexShift,
                session.recommendations,
                this.requestId,
                session.startPos,
                this.nextToken
            )
            this.inlineCompletionProviderDisposable?.dispose()
            // when suggestion is active, registering a new provider will let VS Code invoke inline API automatically
            this.inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
                Object.assign([], CodeWhispererConstants.supportedLanguages),
                inlineCompletionProvider
            )
            this.inlineCompletionProvider = inlineCompletionProvider

            if (isVscHavingRegressionInlineCompletionApi() && !noSuggestionVisible) {
                // fix a regression in new VS Code when disposing and re-registering
                // a new provider does not auto refresh the inline suggestion widget
                // by manually refresh it
                await vscode.commands.executeCommand('editor.action.inlineSuggest.hide')
                await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
            }
            if (noSuggestionVisible) {
                await vscode.commands.executeCommand(`editor.action.inlineSuggest.trigger`)
                this.sendPerceivedLatencyTelemetry()
            }
        })
    }

    async onEditorChange() {
        this.reportUserDecisions(-1)
    }

    async onFocusChange() {
        this.reportUserDecisions(-1)
    }

    async onCursorChange(e: vscode.TextEditorSelectionChangeEvent) {
        // e.kind will be 1 for keyboard cursor change events
        // we do not want to reset the states for keyboard events because they can be typeahead
        if (e.kind !== 1 && vscode.window.activeTextEditor === e.textEditor) {
            application()._clearCodeWhispererUIListener.fire()
            // when cursor change due to mouse movement we need to reset the active item index for inline
            if (e.kind === 2) {
                this.inlineCompletionProvider?.clearActiveItemIndex()
            }
        }
    }

    isSuggestionVisible(): boolean {
        return this.inlineCompletionProvider?.getActiveItemIndex !== undefined
    }

    async tryShowRecommendation() {
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (this.isSuggestionVisible()) {
            // to force refresh the visual cue so that the total recommendation count can be updated
            // const index = this.inlineCompletionProvider?.getActiveItemIndex
            await this.showRecommendation(0, false)
            return
        }
        if (
            editor.selection.active.isBefore(session.startPos) ||
            editor.document.uri.fsPath !== this.documentUri?.fsPath
        ) {
            session.recommendations.forEach((r, i) => {
                session.setSuggestionState(i, 'Discard')
            })
            this.reportUserDecisions(-1)
        } else if (session.recommendations.length > 0) {
            this.subscribeSuggestionCommands()
            // await this.startRejectionTimer(editor)
            await this.showRecommendation(0, true)
        }
    }

    private clearRejectionTimer() {
        if (this._timer !== undefined) {
            clearInterval(this._timer)
            this._timer = undefined
        }
    }

    private sendPerceivedLatencyTelemetry() {
        if (vscode.window.activeTextEditor) {
            const languageContext = runtimeLanguageContext.getLanguageContext(
                vscode.window.activeTextEditor.document.languageId
            )
            telemetry.codewhisperer_perceivedLatency.emit({
                codewhispererRequestId: this.requestId,
                codewhispererSessionId: session.sessionId,
                codewhispererTriggerType: TelemetryHelper.instance.triggerType,
                codewhispererCompletionType: session.getCompletionType(0),
                codewhispererLanguage: languageContext.language,
                duration: performance.now() - this.lastInvocationTime,
                passive: true,
                credentialStartUrl: AuthUtil.instance.startUrl,
                codewhispererUserGroup: CodeWhispererUserGroupSettings.getUserGroup().toString(),
            })
        }
    }
}
