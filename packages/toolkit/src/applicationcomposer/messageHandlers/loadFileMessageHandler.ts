/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path'
import { MessageType, LoadFileRequestMessage, LoadFileResponseMessage, Command, WebviewContext } from '../types'
import vscode from 'vscode'

export async function loadFileMessageHandler(request: LoadFileRequestMessage, context: WebviewContext) {
    let loadFileResponseMessage: LoadFileResponseMessage
    try {
        switch (request.fileName) {
            case '': {
                // load default template file when 'fileName' is empty
                const initFileContents = context.textDocument.getText()
                if (initFileContents === undefined) {
                    throw new Error(`Cannot read file contents from ${context.defaultTemplatePath}`)
                }
                context.fileWatches[context.defaultTemplatePath] = { fileContents: initFileContents }
                loadFileResponseMessage = {
                    messageType: MessageType.RESPONSE,
                    command: Command.LOAD_FILE,
                    eventId: request.eventId,
                    fileName: context.defaultTemplateName,
                    fileContents: initFileContents,
                    isSuccess: true,
                }
                break
            }
            default: {
                const filePath = path.join(context.workSpacePath, request.fileName)
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
                const fileContents = document.getText()
                loadFileResponseMessage = {
                    messageType: MessageType.RESPONSE,
                    command: Command.LOAD_FILE,
                    eventId: request.eventId,
                    fileName: request.fileName,
                    fileContents: fileContents,
                    isSuccess: true,
                }
                break
            }
        }
    } catch (e) {
        loadFileResponseMessage = {
            messageType: MessageType.RESPONSE,
            command: Command.LOAD_FILE,
            eventId: request.eventId,
            fileName: request.fileName,
            fileContents: '',
            isSuccess: false,
            failureReason: (e as Error).message,
        }
    }
    await context.panel.webview.postMessage(loadFileResponseMessage)
}
