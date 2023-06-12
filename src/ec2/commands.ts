/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEc2ConnectPrompter, handleEc2ConnectPrompterResponse } from './prompter'
import { isValidResponse } from '../shared/wizards/wizard'
import { Ec2ConnectClient } from './client'

export async function connectToEC2Instance(): Promise<void> {
    const prompter = createEc2ConnectPrompter()
    const response = await prompter.prompt()

    if(isValidResponse(response)){
        const selection = handleEc2ConnectPrompterResponse(response)
        const ec2Client = new Ec2ConnectClient(selection.region)
        await ec2Client.attemptEc2Connection(selection)
    }
}
