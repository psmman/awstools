/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { setDefaultPolicy } from '../../../iot/commands/setDefaultPolicy'
import { IotNode } from '../../../iot/explorer/iotNodes'
import { IotPolicyFolderNode } from '../../../iot/explorer/iotPolicyFolderNode'
import { IotPolicyWithVersionsNode } from '../../../iot/explorer/iotPolicyNode'
import { IotPolicyVersionNode } from '../../../iot/explorer/iotPolicyVersionNode'
import { IotClient } from '../../../shared/clients/iotClient'
import { getTestWindow } from '../../shared/vscode/window'
import { anything, mock, instance, when, deepEqual, verify } from '../../utilities/mockito'

describe('setDefaultPolicy', function () {
    const policyName = 'test-policy'
    let iot: IotClient
    let node: IotPolicyVersionNode
    let parentNode: IotPolicyWithVersionsNode
    let parentParentNode: IotPolicyFolderNode
    let sandbox: sinon.SinonSandbox
    let spy_executeCommand: sinon.SinonSpy

    beforeEach(function () {
        sandbox = sinon.createSandbox()
        spy_executeCommand = sandbox.spy(vscode.commands, 'executeCommand')

        iot = mock()
        parentParentNode = new IotPolicyFolderNode(instance(iot), new IotNode(instance(iot)))
        parentNode = new IotPolicyWithVersionsNode({ name: policyName, arn: 'arn' }, parentParentNode, instance(iot))
        node = new IotPolicyVersionNode(
            { name: policyName, arn: 'arn' },
            { versionId: 'V1', isDefaultVersion: false },
            false,
            parentNode,
            instance(iot)
        )
    })

    afterEach(function () {
        sandbox.restore()
    })

    it('sets default version and refreshes node', async function () {
        await setDefaultPolicy(node)

        getTestWindow()
            .getFirstMessage()
            .assertInfo(/Set V1 as default version of test-policy/)
        verify(iot.setDefaultPolicyVersion(deepEqual({ policyName, policyVersionId: 'V1' }))).once()

        sandbox.assert.calledWith(spy_executeCommand, 'aws.refreshAwsExplorerNode')
    })

    it('shows an error message and refreshes node when deletion fails', async function () {
        when(iot.setDefaultPolicyVersion(anything())).thenReject(new Error('Expected failure'))
        await setDefaultPolicy(node)

        getTestWindow()
            .getFirstMessage()
            .assertError(/Failed to set default policy version/)

        sandbox.assert.calledWith(spy_executeCommand, 'aws.refreshAwsExplorerNode')
    })
})
