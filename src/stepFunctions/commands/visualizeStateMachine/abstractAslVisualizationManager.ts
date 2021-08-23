/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { ConstructNode } from '../../../cdk/explorer/nodes/constructNode'

import { Logger } from '../../../shared/logger'

const localize = nls.loadMessageBundle()

export abstract class AbstractAslVisualizationManager {
    protected abstract name: string

    public constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.extensionContext = extensionContext
    }

    public abstract visualizeStateMachine(
        globalStorage: vscode.Memento,
        input: vscode.TextEditor | ConstructNode | undefined
    ): Promise<vscode.WebviewPanel | undefined>

    protected pushToExtensionContextSubscriptions(visualizationDisposable: vscode.Disposable): void {
        this.extensionContext.subscriptions.push(visualizationDisposable)
    }

    protected handleErr(err: Error, logger: Logger): void {
        vscode.window.showInformationMessage(
            localize(
                'AWS.stepfunctions.visualisation.errors.rendering',
                'There was an error rendering State Machine Graph, check logs for details.'
            )
        )

        logger.debug(`${this.name}: Unable to setup webview panel.`)
        logger.error(err as Error)
    }
}
