/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { join } from 'path'
import {
    CodeSuggestionsState,
    activate as activateCodeWhisperer,
    shutdown as codewhispererShutdown,
    refreshToolkitQState,
} from 'aws-core-vscode/codewhisperer'
import {
    ExtContext,
    initialize,
    activateLogger,
    activateTelemetry,
    Settings,
    DefaultAwsContext,
    initializeComputeRegion,
    DefaultAWSClientBuilder,
    globals,
    RegionProvider,
} from 'aws-core-vscode/shared'
import { initializeAuth } from 'aws-core-vscode/auth'
import { makeEndpointsProvider, registerCommands } from 'aws-core-vscode'
import { activate as activateCWChat } from 'aws-core-vscode/amazonq'
import { activate as activateQGumby } from 'aws-core-vscode/amazonqGumby'
import { CommonAuthViewProvider } from 'aws-core-vscode/login'
import { isExtensionActive, VSCODE_EXTENSION_ID } from 'aws-core-vscode/utils'
import { registerSubmitFeedback } from 'aws-core-vscode/feedback'

export async function activateShared(context: vscode.ExtensionContext) {
    const contextPrefix = 'amazonq'
    globals.contextPrefix = 'amazonq.' //todo: disconnect from above line

    await initializeComputeRegion()
    initialize(context)
    const extContext = {
        extensionContext: context,
    }
    globals.awsContext = new DefaultAwsContext()
    globals.sdkClientBuilder = new DefaultAWSClientBuilder(globals.awsContext)
    globals.manifestPaths.endpoints = context.asAbsolutePath(join('resources', 'endpoints.json'))
    globals.regionProvider = RegionProvider.fromEndpointsProvider(makeEndpointsProvider())

    const qOutputChannel = vscode.window.createOutputChannel('Amazon Q', { log: true })
    const qLogChannel = vscode.window.createOutputChannel('Amazon Q Logs', { log: true })
    await activateLogger(context, contextPrefix, qOutputChannel, qLogChannel)
    globals.outputChannel = qOutputChannel
    globals.logOutputChannel = qLogChannel

    await activateTelemetry(context, globals.awsContext, Settings.instance)

    await initializeAuth(context, globals.awsContext, globals.loginManager, contextPrefix)

    await activateCodeWhisperer(extContext as ExtContext)
    await activateCWChat(context)
    await activateQGumby(extContext as ExtContext)

    // Generic extension commands
    registerCommands(context, contextPrefix)

    const authProvider = new CommonAuthViewProvider(context, contextPrefix)
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(authProvider.viewType, authProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        registerSubmitFeedback(context, 'Amazon Q', contextPrefix)
    )

    // If the toolkit extension is active, we can let the toolkit extension know
    // that we are installed and can report our connection status.
    if (isExtensionActive(VSCODE_EXTENSION_ID.awstoolkit)) {
        refreshToolkitQState.execute()
    }

    // reload webviews
    await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction')

    // enable auto suggestions on activation
    await CodeSuggestionsState.instance.setSuggestionsEnabled(true)
}

export async function deactivateShared() {
    await codewhispererShutdown()
}
