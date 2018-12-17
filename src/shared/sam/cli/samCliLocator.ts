/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as path from 'path'
import { EnvironmentVariables } from '../../environmentVariables'
import * as filesystemUtilities from '../../filesystemUtilities'

export interface SamCliLocationProvider {
    getLocation(): Promise<string | undefined>
}

export class DefaultSamCliLocationProvider implements SamCliLocationProvider {

    private static SAM_CLI_LOCATOR: BaseSamCliLocator | undefined

    public async getLocation(): Promise<string | undefined> {
        return DefaultSamCliLocationProvider.getSamCliLocator().getLocation()
    }

    public static getSamCliLocator(): SamCliLocationProvider {
        if (!DefaultSamCliLocationProvider.SAM_CLI_LOCATOR) {
            if (process.platform === 'win32') {
                DefaultSamCliLocationProvider.SAM_CLI_LOCATOR = new WindowsSamCliLocator()
            } else {
                DefaultSamCliLocationProvider.SAM_CLI_LOCATOR = new UnixSamCliLocator()
            }
        }

        return DefaultSamCliLocationProvider.SAM_CLI_LOCATOR
    }

}

abstract class BaseSamCliLocator {

    public constructor() {
        this.verifyOs()
    }

    public async getLocation(): Promise<string | undefined> {
        let location: string | undefined = await this.findFileInFolders(
            this.getExecutableFilenames(),
            this.getExecutableFolders()
        )

        if (!location) {
            location = await this.getSystemPathLocation()
        }

        return location
    }

    protected abstract verifyOs(): void
    protected abstract getExecutableFilenames(): string[]
    protected abstract getExecutableFolders(): string[]

    protected async findFileInFolders(
        files: string[],
        folders: string[]
    ): Promise<string | undefined> {
        const fullPaths: string[] = files.map(
            file => folders.map(folder => path.join(folder, file))
        ).reduce(
            (accumulator, paths) => {
                accumulator.push(...paths)

                return accumulator
            }
        )

        for (const fullPath of fullPaths) {
            if (await filesystemUtilities.fileExists(fullPath)) {
                return fullPath
            }
        }

        return undefined
    }

    private async getSystemPathLocation(): Promise<string | undefined> {
        const envVars = process.env as EnvironmentVariables

        if (!!envVars.PATH) {
            const systemPaths: string[] = envVars.PATH!.split(path.delimiter)

            return await this.findFileInFolders(this.getExecutableFilenames(), systemPaths)
        }

        return undefined
    }
}

class WindowsSamCliLocator extends BaseSamCliLocator {

    private static readonly LOCATION_PATHS: string[] = [
        String.raw`C:\Program Files\Amazon\AWSSAMCLI\bin`,
        String.raw`C:\Program Files (x86)\Amazon\AWSSAMCLI\bin`
    ]

    private static readonly EXECUTABLE_FILENAMES: string[] = [
        'sam.cmd',
        'sam.exe'
    ]

    public constructor() {
        super()
    }

    protected verifyOs(): void {
        if (process.platform !== 'win32') {
            throw new Error('Wrong platform')
        }
    }

    protected getExecutableFilenames(): string[] {
        return WindowsSamCliLocator.EXECUTABLE_FILENAMES
    }

    protected getExecutableFolders(): string[] {
        return WindowsSamCliLocator.LOCATION_PATHS
    }

}

class UnixSamCliLocator extends BaseSamCliLocator {

    private static readonly LOCATION_PATHS: string[] = [
        '/usr/local/bin',
        '/usr/bin'
    ]

    private static readonly EXECUTABLE_FILENAMES: string[] = [
        'sam'
    ]

    public constructor() {
        super()
    }

    protected verifyOs(): void {
        if (process.platform === 'win32') {
            throw new Error('Wrong platform')
        }
    }

    protected getExecutableFilenames(): string[] {
        return UnixSamCliLocator.EXECUTABLE_FILENAMES
    }

    protected getExecutableFolders(): string[] {
        return UnixSamCliLocator.LOCATION_PATHS
    }

}
