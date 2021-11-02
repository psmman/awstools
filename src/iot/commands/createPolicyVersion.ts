/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs-extra'
import { getLogger } from '../../shared/logger'
import { Commands } from '../../shared/vscode/commands'
import { Window } from '../../shared/vscode/window'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { showViewLogsMessage } from '../../shared/utilities/messages'
import { IotPolicyWithVersionsNode } from '../explorer/iotPolicyNode'
import { promptForPolicyLocation } from './createPolicy'

/**
 * Creates a new policy version from a policy document.
 */
export async function createPolicyVersionCommand(
    node: IotPolicyWithVersionsNode,
    window = Window.vscode(),
    commands = Commands.vscode()
): Promise<void> {
    getLogger().debug('CreatePolicyVersion called for %O', node)

    const policyName = node.policy.name

    const fileLocation = await promptForPolicyLocation(window)
    if (!fileLocation) {
        getLogger().info('CreatePolicyVersion canceled: No document selected')
        return
    }

    try {
        const data = await fs.readFile(fileLocation.fsPath)
        //Parse to ensure this is a valid JSON
        const policyJSON = JSON.parse(data.toString())
        await node.iot.createPolicyVersion({
            policyName,
            policyDocument: JSON.stringify(policyJSON),
            setAsDefault: true,
        })
    } catch (e) {
        getLogger().error('Failed to create new policy version: %O', e)
        showViewLogsMessage(
            localize('AWS.iot.createPolicyVersion.error', 'Failed to create new policy version'),
            window
        )
        return
    }

    //Refresh the Policy folder node so that this node's children are cleared
    await node.parent.refreshNode(commands)
}
