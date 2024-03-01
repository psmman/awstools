/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import vscode from 'vscode'
import { Command, MessageType, SaveFileRequestMessage, SaveFileResponseMessage, WebviewContext } from '../types'
import path from 'path'
import { fsCommon } from '../../srcShared/fs'
import { templateShouldBeUpdated } from '../util'

export async function saveFileMessageHandler(request: SaveFileRequestMessage, context: WebviewContext) {
    async function updateTextDocument(existingTemplate: string, fileUri: vscode.Uri) {
        if (await templateShouldBeUpdated(existingTemplate, request.fileContents)) {
            const edit = new vscode.WorkspaceEdit()
            edit.replace(fileUri, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), request.fileContents)
            await vscode.workspace.applyEdit(edit)
        }
    }

    let saveFileResponseMessage: SaveFileResponseMessage
    // If filePath is empty, save contents in default template file
    const filePath =
        request.filePath === '' ? context.defaultTemplatePath : path.join(context.workSpacePath, request.filePath)

    try {
        context.fileWatches[filePath] = { fileContents: request.fileContents }
        const fileUri = vscode.Uri.file(filePath)
        if (await fsCommon.existsFile(fileUri)) {
            const textDoc = vscode.workspace.textDocuments.find(it => it.uri.path === fileUri.path)
            const existingTemplate = textDoc?.getText() ?? (await fsCommon.readFileAsString(fileUri))
            await updateTextDocument(existingTemplate, fileUri)
        } else {
            await fsCommon.writeFile(fileUri, request.fileContents)
        }
        saveFileResponseMessage = {
            messageType: MessageType.RESPONSE,
            command: Command.SAVE_FILE,
            eventId: request.eventId,
            filePath: filePath,
            isSuccess: true,
        }
    } catch (e) {
        saveFileResponseMessage = {
            messageType: MessageType.RESPONSE,
            command: Command.SAVE_FILE,
            eventId: request.eventId,
            filePath: filePath,
            isSuccess: false,
            failureReason: (e as Error).message,
        }
    }

    await context.panel.webview.postMessage(saveFileResponseMessage)
}
