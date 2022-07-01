/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as vscode from 'vscode'
import { copyLogStreamName } from '../../../cloudWatchLogs/commands/copyLogStreamName'
import { CLOUDWATCH_LOGS_SCHEME } from '../../../shared/constants'

describe('copyLogStreamName', async function () {
    beforeEach(async function () {
        await vscode.env.clipboard.writeText('')
    })

    afterEach(async function () {
        await vscode.env.clipboard.writeText('')
    })

    it('copies stream names from valid URIs and does not copy anything new if the URI is invalid', async function () {
        const streamName = 'stream'
        const action = 'viewLogStream'

        await copyLogStreamName(vscode.Uri.parse(`${CLOUDWATCH_LOGS_SCHEME}:${action}:group:region:${streamName}`))

        assert.strictEqual(await vscode.env.clipboard.readText(), streamName)
        await copyLogStreamName(vscode.Uri.parse(`notCloudWatch:hahahaha`))

        assert.strictEqual(await vscode.env.clipboard.readText(), streamName)
    })
})
