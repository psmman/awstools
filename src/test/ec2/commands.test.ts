/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert'
import * as vscode from 'vscode'
import { copyInstanceId } from '../../ec2/commands'

describe('copyInstanceId', async function () {
    beforeEach(async function () {
        await vscode.env.clipboard.writeText('')
    })

    it('copies instance id when provided one', async function () {
        const testInstanceId = 'thisIsMyFavoriteId'

        await copyInstanceId(testInstanceId)

        assert.strictEqual(await vscode.env.clipboard.readText(), testInstanceId)
    })
})
