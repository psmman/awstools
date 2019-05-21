/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as handlebars from 'handlebars'
import * as path from 'path'

import { StsClient } from '../clients/stsClient'
import { EnvironmentVariables } from '../environmentVariables'
import { ext } from '../extensionGlobals'
import { mkdir, writeFile } from '../filesystem'
import { fileExists, readFileAsString } from '../filesystemUtilities'
import { getLogger, Logger } from '../logger'
import { SystemUtilities } from '../systemUtilities'

/**
 * The payload used to fill in the handlebars template
 * for the simple credentials file.
 */
export interface CredentialsTemplateContext {
    profileName: string
    accessKey: string
    secretKey: string
}

export interface CredentialsValidationResult {
    isValid: boolean,
    invalidMessage?: string
}

export class UserCredentialsUtils {

    /**
     * @description Determines which credentials related files
     * exist, and returns their filenames.
     *
     * @returns array of filenames for files found.
     */
    public static async findExistingCredentialsFilenames(): Promise<string[]> {
        const candidateFiles: string[] = [
            this.getCredentialsFilename(),
            this.getConfigFilename()
        ]

        const existsResults: boolean[] = await Promise.all(
            candidateFiles.map(async filename => await SystemUtilities.fileExists(filename))
        )

        return candidateFiles.filter((filename, index) => existsResults[index])
    }

    /**
     * @returns Filename for the credentials file
     */
    public static getCredentialsFilename(): string {
        const env = process.env as EnvironmentVariables

        return env.AWS_SHARED_CREDENTIALS_FILE
            || path.join(SystemUtilities.getHomeDirectory(), '.aws', 'credentials')
    }

    /**
     * @returns Filename for the config file
     */
    public static getConfigFilename(): string {
        const env = process.env as EnvironmentVariables

        return env.AWS_CONFIG_FILE
            || path.join(SystemUtilities.getHomeDirectory(), '.aws', 'config')
    }

    /**
     * @description Determines if credentials directory exists
     * If it doesn't, creates credentials directory
     * at directory from this.getCredentialsFilename()
     */
    public static async generateCredentialDirectoryIfNonexistent(): Promise<void> {
        const filepath = path.dirname(this.getCredentialsFilename())
        if (!await fileExists(filepath)) {
            await mkdir(filepath, { recursive: true })
        }
    }

    /**
     * @description Produces a credentials file from a template
     * containing a single profile based on the given information
     *
     * @param credentialsContext the profile to create in the file
     */
    public static async generateCredentialsFile(
        extensionPath: string,
        credentialsContext: CredentialsTemplateContext
    ): Promise<void> {
        const templatePath: string = path.join(extensionPath, 'resources', 'newUserCredentialsFile')

        const credentialsTemplate: string = await readFileAsString(templatePath)

        const handlebarTemplate = handlebars.compile(credentialsTemplate)
        const credentialsFileContents = handlebarTemplate(credentialsContext)

        // Make a final check
        if (await SystemUtilities.fileExists(this.getCredentialsFilename())) {
            throw new Error('Credentials file exists. Not overwriting it.')
        }

        await writeFile(this.getCredentialsFilename(), credentialsFileContents, {
            encoding: 'utf8',
            mode: 0o100600 // basic file (type 100) with 600 permissions
        })
    }

    /**
     * @description Tests if the given credentials are valid by making a request to AWS
     *
     * @param accessKey access key of credentials to validate
     * @param secretKey secret key of credentials to validate
     * @param sts (Optional) STS Service Client
     *
     * @returns a validation result, indicating whether or not credentials are valid, and if not,
     * an error message.
     */
    public static async validateCredentials(
        accessKeyId: string,
        secretAccessKey: string,
        sts?: StsClient
    ): Promise<CredentialsValidationResult> {
        const logger: Logger = getLogger()
        try {
            if (!sts) {
                // Past iteration did not include a set region. Should we change this?
                // We can also use the set region when we migrate to a single-region experience:
                // https://github.com/aws/aws-toolkit-vscode/issues/549
                sts = ext.toolkitClientBuilder.createStsClient('us-east-1', {accessKeyId, secretAccessKey})
            }

            const response = await sts.getCallerIdentity()

            return { isValid: !!response.Account }

        } catch (err) {

            let reason: string

            if (err instanceof Error) {
                const error = err as Error
                reason = error.message
                logger.error(error)
            } else {
                reason = err as string
            }

            return { isValid: false, invalidMessage: reason }
        }
    }
}
