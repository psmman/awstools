/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { registerCommand } from '../shared/telemetry/telemetryUtils'
import { AwsCdkExplorer } from './explorer/awsCdkExplorer'
import { cdk } from './globals'

/**
 * Activate AWS CDK related functionality for the extension.
 */
export async function activate(activateArguments: { extensionContext: vscode.ExtensionContext }): Promise<void> {
    const explorer = new AwsCdkExplorer()

    initializeIconPaths(activateArguments.extensionContext)

    await registerCdkCommands(explorer)
    activateArguments.extensionContext.subscriptions.push(
        vscode.window.registerTreeDataProvider(explorer.viewProviderId, explorer)
    )
}

function initializeIconPaths(context: vscode.ExtensionContext) {
    cdk.iconPaths.dark.cdk = context.asAbsolutePath('resources/dark/cdk/cdk.svg')
    cdk.iconPaths.light.cdk = context.asAbsolutePath('resources/light/cdk/cdk.svg')

    cdk.iconPaths.dark.cloudFormation = context.asAbsolutePath('resources/dark/cdk/cloudformation.svg')
    cdk.iconPaths.light.cloudFormation = context.asAbsolutePath('resources/light/cdk/cloudformation.svg')
}

async function registerCdkCommands(explorer: AwsCdkExplorer): Promise<void> {
    registerCommand({
        command: 'aws.refreshCdkExplorer',
        callback: async () => explorer.refresh()
    })
}
