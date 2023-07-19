/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolkitError } from '../shared/errors'
import { ChildProcess } from '../shared/utilities/childProcess'

export class SshKeyPair {
    private constructor(protected keyPath: string) {}

    public static async generateSshKeys(keyPath: string) {
        const process = new ChildProcess('ssh-keygen', ['-t', 'rsa', '-N', "''", '-q', '-f', keyPath])
        const result = await process.run()
        if (result.exitCode !== 0) {
            throw new ToolkitError('ec2: Failed to generate ssh key')
        }

        return new SshKeyPair(keyPath)
    }

    public getPublicKey(): string {
        return ''
    }
}
