/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'path'
import * as vscode from 'vscode'
import { ext } from '../shared/extensionGlobals'
import { registerCommand } from '../shared/telemetry/telemetryUtils'
import { visualizeStateMachine } from './commands/visualizeStateMachine'

/**
 * Activate Step Functions related functionality for the extension.
 */
export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
    await registerStepFunctionCommands(extensionContext)
}

async function registerStepFunctionCommands(extensionContext: vscode.ExtensionContext): Promise<void> {

    initalizeWebviewPaths(extensionContext)

    extensionContext.subscriptions.push(
        registerCommand({
            command: 'aws.renderStateMachine',
            callback: async () => {
                return await visualizeStateMachine(extensionContext.globalState)
            }
        })
    )
}

function initalizeWebviewPaths(context: vscode.ExtensionContext) {
    ext.visualizationResourcePaths.visualizationCache =
        vscode.Uri.file(context.asAbsolutePath('visualization'))

    ext.visualizationResourcePaths.visualizationScript =
        vscode.Uri.file(context.asAbsolutePath(join('visualization', 'graph.js')))

    ext.visualizationResourcePaths.visualizationCSS =
        vscode.Uri.file(context.asAbsolutePath(join('visualization','graph.css')))

    ext.visualizationResourcePaths.stateMachineThemePath =
        vscode.Uri.file(context.asAbsolutePath(join('media', 'css')))

    ext.visualizationResourcePaths.stateMachineThemeCSS =
        vscode.Uri.file(context.asAbsolutePath(join('media', 'css', 'stateMachineRender.css')))

    ext.visualizationResourcePaths.localScriptsPath =
        vscode.Uri.file(context.asAbsolutePath(join('media', 'js')))

    ext.visualizationResourcePaths.webviewScript =
        vscode.Uri.file(context.asAbsolutePath(join('media', 'js', 'graphStateMachine.js')))
}
