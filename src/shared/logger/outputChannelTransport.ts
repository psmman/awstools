/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import Transport from 'winston-transport'
import globals from '../extensionGlobals'
import { removeAnsi } from '../utilities/textUtilities'
import { LogLevel } from './logger'

export const MESSAGE = Symbol.for('message') // eslint-disable-line @typescript-eslint/naming-convention

interface LogEntry {
    level: string
    message: string
    [MESSAGE]: string
    raw: boolean
}

export class OutputChannelTransport extends Transport {
    private readonly outputChannel: Pick<vscode.OutputChannel, 'append' | 'appendLine'>
    // True if `outputChannel` is a `vscode.LogOutputChannel`.
    private readonly isLogChan: boolean
    private readonly stripAnsi: boolean

    public constructor(
        options: Transport.TransportStreamOptions & {
            outputChannel: Pick<vscode.OutputChannel, 'append' | 'appendLine'>
            stripAnsi?: boolean
            name?: string
        }
    ) {
        super(options)

        this.outputChannel = options.outputChannel
        this.stripAnsi = options.stripAnsi ?? false

        const c = this.outputChannel
        this.isLogChan = (c as any).info && (c as any).trace && (c as any).debug && (c as any).warn && (c as any).error
        // Else: we got `vscode.debug.activeDebugConsole` which does not yet implement `vscode.LogOutputChannel`.
    }

    public override log(info: LogEntry, next: () => void): void {
        globals.clock.setImmediate(() => {
            if (this.isLogChan) {
                // Example input:
                //      message: 'Preparing to debug locally: Lambda "index.handler"'
                //      raw: true
                //      Symbol(level): 'info'
                //      Symbol(message): '2024-01-16 08:54:30 [INFO]: Preparing to debug locally: Lambda "index.handler"'
                //      Symbol(splat): (1) [{…}]
                //      timestamp: '2024-01-16 08:54:30'
                // We want the "raw" (unformatted) message without the frontmatter, because
                // `vscode.LogOutputChannel` presents its own timestamp + loglevel.
                const unformattedMsg = this.stripAnsi ? removeAnsi(info.message) : info.message
                // Avoid extra line breaks.
                const msg = info.raw ? unformattedMsg.trim() : unformattedMsg

                const c = this.outputChannel as vscode.LogOutputChannel
                const loglevel = info.level as LogLevel
                if (loglevel === 'error') {
                    c.error(msg)
                } else if (loglevel === 'warn') {
                    c.warn(msg)
                } else if (loglevel === 'debug' || loglevel === 'verbose') {
                    c.debug(msg)
                } else {
                    c.info(msg)
                }
            } else {
                const msg = this.stripAnsi ? removeAnsi(info[MESSAGE]) : info[MESSAGE]
                if (info.raw) {
                    this.outputChannel.append(msg)
                } else {
                    this.outputChannel.appendLine(msg)
                }
            }

            this.emit('logged', info)
        })

        next()
    }
}
