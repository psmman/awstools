/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as assert from 'assert'
import { SpawnOptions } from 'child_process'

import { TestLogger } from '../../../../shared/loggerUtils'
import { SamCliProcessInvoker } from '../../../../shared/sam/cli/samCliInvokerUtils'
import { ChildProcessResult } from '../../../../shared/utilities/childProcess'

export class TestSamCliProcessInvoker implements SamCliProcessInvoker {
    public constructor(
        private readonly onInvoke: (spawnOptions: SpawnOptions, ...args: any[]) => ChildProcessResult
    ) {
    }

    public invoke(options: SpawnOptions, ...args: string[]): Promise<ChildProcessResult>
    public invoke(...args: string[]): Promise<ChildProcessResult>
    public async invoke(first: SpawnOptions | string, ...rest: string[]): Promise<ChildProcessResult> {
        const args = typeof first === 'string' ? [first, ...rest] : rest
        const spawnOptions: SpawnOptions = typeof first === 'string' ? {} : first

        return this.onInvoke(spawnOptions, args)
    }
}

export class BadExitCodeSamCliProcessInvoker extends TestSamCliProcessInvoker {

    public exitCode: number
    public error: Error
    public stdout: string
    public stderr: string

    public constructor({
        exitCode = -1,
        error = new Error('Bad Result'),
        stdout = 'stdout message',
        stderr = 'stderr message',
    }: {
        exitCode?: number
        error?: Error
        stdout?: string
        stderr?: string
    }) {
        super((spawnOptions: SpawnOptions, ...args: any[]) => {
            return this.makeChildProcessResult()
        })

        this.exitCode = exitCode
        this.error = error
        this.stdout = stdout
        this.stderr = stderr
    }

    public makeChildProcessResult(): ChildProcessResult {
        const result: ChildProcessResult = {
            exitCode: this.exitCode,
            error: this.error,
            stdout: this.stdout,
            stderr: this.stderr,
        }

        return result
    }
}

export function assertErrorContainsBadExitMessage(
    actualError: Error,
    sourceErrorMessage: string
) {
    assert.strictEqual(
        actualError.message, `Error with child process: ${sourceErrorMessage}`,
        'Unexpected error message'
    )
}

export async function assertLogContainsBadExitInformation(
    logger: TestLogger,
    expectedChildProcessResult: ChildProcessResult
): Promise<void> {
    assert.ok(
        await logger.logContainsText(`Unexpected exitcode (${expectedChildProcessResult.exitCode})`),
        'Log message missing for exit code'
    )
    assert.ok(
        await logger.logContainsText(`Error: ${expectedChildProcessResult.error}`),
        'Log message missing for error'
    )
    assert.ok(
        await logger.logContainsText(`stderr: ${expectedChildProcessResult.stderr}`),
        'Log message missing for stderr'
    )
    assert.ok(
        await logger.logContainsText(`stdout: ${expectedChildProcessResult.stdout}`),
        'Log message missing for stdout'
    )
}
