/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as AWS from 'aws-sdk'
import { Profile } from '../../shared/credentials/credentialsFile'
import { getLogger } from '../../shared/logger'
import { getMfaTokenFromUser } from '../credentialsCreator'
import { CredentialProviderChainProvider } from './credentialProviderChainProvider'
import { makeCredentialsProviderId } from './credentialsProviderId'

const SHARED_CREDENTIAL_PROPERTIES = {
    AWS_SESSION_TOKEN: 'aws_session_token',
    AWS_ACCESS_KEY_ID: 'aws_access_key_id',
    AWS_SECRET_ACCESS_KEY: 'aws_secret_access_key',
    CREDENTIAL_PROCESS: 'credential_process',
    ROLE_ARN: 'role_arn',
    SOURCE_PROFILE: 'source_profile'
}

/**
 * Represents one profile from the AWS Shared Credentials files, and produces CredentialProviderChain objects for this profile.
 */
export class SharedCredentialsProviderChainProvider implements CredentialProviderChainProvider {
    public static readonly CREDENTIALS_TYPE = 'profile'

    private readonly profile: Profile

    public constructor(
        private readonly profileName: string,
        private readonly allSharedCredentialProfiles: Map<string, Profile>
    ) {
        const profile = this.allSharedCredentialProfiles.get(profileName)

        if (!profile) {
            throw new Error(`Profile not found: ${profileName}`)
        }

        this.profile = profile
    }

    public getCredentialsProviderId(): string {
        return makeCredentialsProviderId({
            credentialType: SharedCredentialsProviderChainProvider.CREDENTIALS_TYPE,
            providerId: this.profileName
        })
    }

    /**
     * Throws an Error if the profile is not valid
     */
    public async validate(): Promise<void> {
        if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.ROLE_ARN)) {
            this.validateSourceProfileChain()
        } else if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.CREDENTIAL_PROCESS)) {
            // No validation. Don't check anything else.
        } else if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.AWS_SESSION_TOKEN)) {
            this.verifyProfilePropertiesExist(
                SHARED_CREDENTIAL_PROPERTIES.AWS_ACCESS_KEY_ID,
                SHARED_CREDENTIAL_PROPERTIES.AWS_SECRET_ACCESS_KEY
            )
        } else if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.AWS_ACCESS_KEY_ID)) {
            this.verifyProfilePropertiesExist(SHARED_CREDENTIAL_PROPERTIES.AWS_SECRET_ACCESS_KEY)
        }
    }

    public async getCredentialProviderChain(): Promise<AWS.CredentialProviderChain> {
        await this.validate()

        const provider = new AWS.CredentialProviderChain([this.makeCredentialsProvider()])

        return provider
    }

    private hasProfileProperty(propertyName: string): boolean {
        return !!this.profile[propertyName]
    }

    /**
     * Throws an error indicating which properties are missing
     */
    private verifyProfilePropertiesExist(...propertyNames: string[]) {
        const missingProperties = propertyNames.filter(propertyName => !this.profile[propertyName])

        if (missingProperties.length > 0) {
            throw new Error(`Profile ${this.profileName} is missing properties: ${missingProperties.join(', ')}`)
        }
    }

    private validateSourceProfileChain() {
        const profilesTraversed: string[] = [this.profileName]

        let profileName = this.profileName
        let profile = this.profile

        while (!!profile[SHARED_CREDENTIAL_PROPERTIES.SOURCE_PROFILE]) {
            profileName = profile[SHARED_CREDENTIAL_PROPERTIES.SOURCE_PROFILE]!

            // Cycle
            if (profilesTraversed.indexOf(profileName) !== -1) {
                profilesTraversed.push(profileName)
                throw new Error(
                    `Cycle detected within Shared Credentials Profiles. Reference chain: ${profilesTraversed.join(
                        ' -> '
                    )}`
                )
            }

            profilesTraversed.push(profileName)

            // Missing reference
            if (!this.allSharedCredentialProfiles.has(profileName)) {
                throw new Error(
                    `Shared Credentials Profile ${profileName} not found. Reference chain: ${profilesTraversed.join(
                        ' -> '
                    )}`
                )
            }

            profile = this.allSharedCredentialProfiles.get(profileName)!
        }
    }

    private makeCredentialsProvider(): () => AWS.Credentials {
        const logger = getLogger()

        if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.ROLE_ARN)) {
            logger.verbose(
                `Profile ${this.profileName} contains ${SHARED_CREDENTIAL_PROPERTIES.ROLE_ARN} - treating as regular Shared Credentials`
            )

            return this.makeSharedIniFileCredentialsProvider()
        }

        if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.CREDENTIAL_PROCESS)) {
            logger.verbose(
                `Profile ${this.profileName} contains ${SHARED_CREDENTIAL_PROPERTIES.CREDENTIAL_PROCESS} - treating as Process Credentials`
            )

            return () => new AWS.ProcessCredentials({ profile: this.profileName })
        }

        if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.AWS_SESSION_TOKEN)) {
            logger.verbose(
                `Profile ${this.profileName} contains ${SHARED_CREDENTIAL_PROPERTIES.AWS_SESSION_TOKEN} - treating as regular Shared Credentials`
            )

            return this.makeSharedIniFileCredentialsProvider()
        }

        if (this.hasProfileProperty(SHARED_CREDENTIAL_PROPERTIES.AWS_ACCESS_KEY_ID)) {
            logger.verbose(
                `Profile ${this.profileName} contains ${SHARED_CREDENTIAL_PROPERTIES.AWS_ACCESS_KEY_ID} - treating as regular Shared Credentials`
            )

            return this.makeSharedIniFileCredentialsProvider()
        }

        logger.error(`Profile ${this.profileName} did not contain any supported properties`)
        throw new Error(`Shared Credentials profile ${this.profileName} is not supported`)
    }

    private makeSharedIniFileCredentialsProvider(): () => AWS.Credentials {
        return () =>
            new AWS.SharedIniFileCredentials({
                profile: this.profileName,
                tokenCodeFn: async (mfaSerial, callback) =>
                    await getMfaTokenFromUser(mfaSerial, this.profileName, callback)
            })
    }
}
