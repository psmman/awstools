/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { getLogger } from '../shared/logger'
import { Message } from './client'
import { AsyncResource } from 'async_hooks'
import { ToolkitError } from '../shared/errors'
import { showErrorToUser } from '../shared/utilities/errorUtils'

interface Command<T extends any[] = any, R = any> {
    (...args: T): R | never
}

export interface Protocol {
    [key: string]: Command | vscode.EventEmitter<any> | undefined
}

/**
 * Sets up an event listener for the webview to call registered commands.
 *
 * @param webview Target webview to add the event hook.
 * @param commands Commands to register.
 * @param webviewId A human readable string that will identify the webview
 */
export function registerWebviewServer(
    webview: vscode.Webview,
    commands: Protocol,
    webviewId: string
): vscode.Disposable {
    const eventListeners: vscode.Disposable[] = []
    const disposeListeners = () => {
        while (eventListeners.length) {
            eventListeners.pop()?.dispose()
        }
    }

    const messageListener = webview.onDidReceiveMessage(
        // XXX: In earlier versions of Node the first parameter was used as
        // the `thisArg` for calling the bound function.
        //
        // Fixed in https://github.com/nodejs/node/commit/324a6c235a5bfcbcd7cc7491d55461915c10af34
        AsyncResource.bind(async function (this: any, event: Message) {
            const { id, command, data } = event ?? (this as Message)
            const metadata: Omit<Message, 'id' | 'command' | 'data'> = {}

            const handler = commands[command]

            if (!handler) {
                return getLogger().warn(`Received invalid message from client: ${command}`)
            }

            if (id === '0') {
                disposeListeners() // Webview reloaded, dispose all listeners
            }

            if (handler instanceof vscode.EventEmitter) {
                // TODO: make server dipose of event if client calls `dispose`
                eventListeners.push(handler.event(e => webview.postMessage({ command, event: true, data: e })))
                getLogger().verbose(`Registered event handler for: ${command}`)
                return webview.postMessage({ id, command, event: true })
            }

            // TODO: these commands could potentially have sensitive data, we don't want to log in that case
            getLogger().debug(`Webview called command "${command}" with args: %O`, data)

            let result: any
            try {
                result = await handler.call(webview, ...data)
            } catch (err) {
                if (!(err instanceof Error)) {
                    getLogger().debug(`Webview server threw on command "${command}" but it was not an error: `, err)
                    return
                }
                result = JSON.stringify(err, Object.getOwnPropertyNames(err))
                delete result.stack // Not relevant to frontend code, we only care about the message
                metadata.error = true

                // A command failed in the backend/server, this will surface the error to the user as a vscode error message.
                // This is the base error handler that will end up catching all unhandled errors.
                showLoggedErrorToUser(err, webviewId, command)
            }

            // TODO: check if webview has been disposed of before posting message (not necessary but nice)
            // We also get a boolean value back, maybe retry sending on false?
            webview.postMessage({ id, command, data: result, ...metadata })
        })
    )

    return { dispose: () => (messageListener.dispose(), disposeListeners()) }
}

/**
 * Show an error to the user + button that links to the logged error
 *
 * @param err The error that was thrown in the backend
 * @param webviewId Arbitrary value that identifies which webview had the error
 * @param command The high level command/function that was run which triggered the error
 */
export function showLoggedErrorToUser(err: unknown, webviewId: string, command: string) {
    // HACK: The following implementation is a hack, influenced by the implementation of handleError().
    // The userFacingError message will be seen in the UI, and the detailedError message will provide the
    // detailed information in the logs.
    const detailedError = ToolkitError.chain(
        err,
        `The backend command "${command}()" failed when executed by the webview.`
    )
    const userFacingError = ToolkitError.chain(detailedError, 'A webview had an error.')
    showErrorToUser(userFacingError, `webviewId="${webviewId}"`, 'A webview had an error.')
}
