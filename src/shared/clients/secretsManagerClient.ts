/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */



import {
    CreateSecretCommandInput,
    CreateSecretCommandOutput,
    ListSecretsCommandInput,
    ListSecretsCommandOutput,
    SecretsManager,
} from "@aws-sdk/client-secrets-manager";

import globals from '../extensionGlobals'
import { productName } from '../constants'

export class SecretsManagerClient {
    public constructor(
        public readonly regionCode: string,
        private readonly secretsManagerClientProvider: (
            regionCode: string
        ) => Promise<SecretsManager> = createSecretsManagerClient
    ) {}

    /**
     * Lists the secrets that are stored by Secrets Manager
     * @param filter tagged key filter value
     * @returns a list of the secrets
     */
    public async listSecrets(filter: string): Promise<ListSecretsCommandOutput> {
        const secretsManagerClient = await this.secretsManagerClientProvider(this.regionCode)
        const request: ListSecretsCommandInput = {
            IncludePlannedDeletion: false,
            Filters: [
                {
                    Key: 'tag-key',
                    Values: [filter],
                },
            ],
            SortOrder: 'desc',
        }
        return secretsManagerClient.listSecrets(request).promise()
    }

    public async createSecret(secretString: string, username: string, password: string): Promise<CreateSecretCommandOutput> {
        const secretsManagerClient = await this.secretsManagerClientProvider(this.regionCode)
        const request: CreateSecretCommandInput = {
            Description: `Database secret created with ${productName}`,
            Name: secretString ? secretString : '',
            SecretString: JSON.stringify({ username, password }),
            Tags: [
                {
                    Key: 'Service',
                    Value: 'Redshift',
                },
                {
                    Key: 'Request-Source',
                    Value: productName,
                },
            ],
            ForceOverwriteReplicaSecret: true,
        }
        return secretsManagerClient.createSecret(request).promise()
    }
}

async function createSecretsManagerClient(regionCode: string): Promise<SecretsManager> {
    return await globals.sdkClientBuilder.createAwsService(SecretsManager, { computeChecksums: true }, regionCode)
}
