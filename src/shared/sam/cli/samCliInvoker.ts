/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from '../../logger'
import { ChildProcess, ChildProcessResult } from '../../utilities/childProcess'
import {
    makeRequiredSamCliProcessInvokeOptions,
    SamCliProcessInvokeOptions,
    SamCliProcessInvoker,
} from './samCliInvokerUtils'
import { DefaultSamCliProcessInvokerContext } from './samCliProcessInvokerContext'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

/**
 * Yet another `sam` CLI wrapper.
 *
 * TODO: Merge this with `DefaultSamLocalInvokeCommand`.
 */
export class DefaultSamCliProcessInvoker implements SamCliProcessInvoker {
    private childProcess?: ChildProcess
    public constructor(
        private readonly context: {
            cliConfig: { getOrDetectSamCli(): Promise<{ path: string; autoDetected: boolean }> }
        } = new DefaultSamCliProcessInvokerContext()
    ) {}

    public stop(): void {
        if (!this.childProcess) {
            throw new Error('not started')
        }
        this.childProcess.stop()
    }

    public async invoke(options?: SamCliProcessInvokeOptions): Promise<ChildProcessResult> {
        const invokeOptions = makeRequiredSamCliProcessInvokeOptions(options)
        const logger = getLogger()

        const sam = await this.context.cliConfig.getOrDetectSamCli()
        if (sam.autoDetected) {
            logger.info('SAM CLI not configured, using SAM found at: %O', sam.path)
        }

        const samCommand = sam.path ? sam.path : 'sam'
        this.childProcess = new ChildProcess(samCommand, invokeOptions.spawnOptions, ...invokeOptions.arguments)

        getLogger('channel').info(localize('AWS.running.command', 'Running command: {0}', `${this.childProcess}`))
        logger.verbose(`running: ${this.childProcess}`)
        return await this.childProcess.run(
            (text: string) => {
                getLogger('debugConsole').info(text)
                logger.verbose(`stdout: ${text}`)
                if (options?.onStdout) {
                    options.onStdout(text)
                }
            },
            (text: string) => {
                getLogger('debugConsole').info(text)
                logger.verbose(`stderr: ${text}`)
                if (options?.onStderr) {
                    options.onStderr(text)
                }
            }
        )
    }
}
