/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AddFileWatchRequestMessage,
    AddFileWatchResponseMessage,
    MessageType,
    FileChangedMessage,
    Command,
    WebviewContext,
} from '../types'
import vscode from 'vscode'

import { templateShouldBeUpdated } from '../util'
import { bufferTimeMs } from '../constants'

let timeSinceLastChange = 0

function bufferTextDocumentChange(event: vscode.TextDocumentChangeEvent, context: WebviewContext) {
    timeSinceLastChange = Date.now()
    setTimeout(async () => {
        if (Date.now() - timeSinceLastChange < bufferTimeMs) {
            return
        }

        const fileContents = event.document.getText()
        const filePath = context.defaultTemplatePath
        const fileName = context.defaultTemplateName

        if (await templateShouldBeUpdated(context.fileWatches[filePath].fileContents, fileContents)) {
            context.fileWatches[filePath] = { fileContents: fileContents }
            const fileChangedMessage: FileChangedMessage = {
                messageType: MessageType.BROADCAST,
                command: Command.FILE_CHANGED,
                fileName: fileName,
                fileContents: fileContents,
            }
            await context.panel.webview.postMessage(fileChangedMessage)
        }
    }, bufferTimeMs)
}

export async function addFileWatchMessageHandler(request: AddFileWatchRequestMessage, context: WebviewContext) {
    let addFileWatchResponseMessage: AddFileWatchResponseMessage
    try {
        // we only file watch on default template file now
        if (context.defaultTemplateName !== request.fileName) {
            throw new Error('file watching is only allowed on default template file')
        }
        vscode.workspace.onDidChangeTextDocument(async event => {
            if (event.document.fileName !== context.textDocument.fileName || event.contentChanges.length === 0) {
                return
            }
            bufferTextDocumentChange(event, context)
        })

        addFileWatchResponseMessage = {
            messageType: MessageType.RESPONSE,
            command: Command.ADD_FILE_WATCH,
            eventId: request.eventId,
            isSuccess: true,
        }
    } catch (e) {
        addFileWatchResponseMessage = {
            messageType: MessageType.RESPONSE,
            command: Command.ADD_FILE_WATCH,
            eventId: request.eventId,
            isSuccess: false,
            failureReason: (e as Error).message,
        }
    }

    await context.panel.webview.postMessage(addFileWatchResponseMessage)
}
