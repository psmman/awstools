/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { CloudWatchLogsData, LogStreamRegistry } from '../registry/logStreamRegistry'
import { highlightDocument } from '../document/logStreamDocumentProvider'
import { createURIFromArgs } from '../cloudWatchLogsUtils'

export async function changeFilterPattern(registry: LogStreamRegistry): Promise<void> {
    const currentEditor = vscode.window.activeTextEditor
    if (!currentEditor) {
        throw new Error('cwl: Failed to identify active editor.')
    }

    const oldUri = currentEditor.document.uri
    if (!registry.hasLog(oldUri)) {
        throw new Error('cwl: Document open has unregistered uri.')
    }

    const oldData = registry.getLogData(oldUri) as CloudWatchLogsData
    const newFilterPattern = 'error'

    // Overwrite old data to remove old events, tokens, and filterPattern.
    const newData: CloudWatchLogsData = {
        ...oldData,
        data: [],
        next: undefined,
        previous: undefined,
        parameters: {
            ...oldData.parameters,
            filterPattern: newFilterPattern,
        },
    }

    // Remove old search
    registry.deregisterLog(oldUri)
    const newUri = createURIFromArgs(oldData.logGroupInfo, oldData.parameters)
    await registry.registerLog(newUri, newData)
    const doc = await vscode.workspace.openTextDocument(newUri) // calls back into the provider
    vscode.languages.setTextDocumentLanguage(doc, 'log')
    const textEditor = await vscode.window.showTextDocument(doc, { preview: false })
    registry.setTextEditor(newUri, textEditor)
    highlightDocument(registry, newUri)
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
        if (event.document.uri.toString() === doc.uri.toString()) {
            highlightDocument(registry, newUri)
        }
    })
}
