/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as fs from 'fs-extra'
import * as path from 'path'
import { makeTemporaryToolkitFolder } from '../../../../shared/filesystemUtilities'
import { DefaultSamCliConfiguration, SamCliConfiguration } from '../../../../shared/sam/cli/samCliConfiguration'
import { SamCliLocationProvider } from '../../../../shared/sam/cli/samCliLocator'
import { TestSettingsConfiguration } from '../../../utilities/testSettingsConfiguration'

describe('SamCliConfiguration', function () {
    let tempFolder: string
    let settingsConfiguration: TestSettingsConfiguration

    beforeEach(async function () {
        tempFolder = await makeTemporaryToolkitFolder()
        settingsConfiguration = new TestSettingsConfiguration()
    })

    afterEach(async function () {
        await fs.remove(tempFolder)
    })

    it('uses config value when referencing file that exists', async function () {
        const fakeCliLocation = path.join(tempFolder, 'fakeSamCli')

        createSampleFile(fakeCliLocation)
        await settingsConfiguration.writeSetting(
            DefaultSamCliConfiguration.CONFIGURATION_KEY_SAMCLI_LOCATION,
            fakeCliLocation,
            ''
        )

        const samCliConfig: SamCliConfiguration = new DefaultSamCliConfiguration(
            settingsConfiguration,
            ({} as any) as SamCliLocationProvider
        )

        await samCliConfig.initialize()

        assert.strictEqual(samCliConfig.getSamCliLocation(), fakeCliLocation)
    })

    it('calls location provider when config not set', async function () {
        let timesCalled: number = 0

        const samCliConfig: SamCliConfiguration = new DefaultSamCliConfiguration(settingsConfiguration, {
            getLocation: async (): Promise<string | undefined> => {
                timesCalled++

                return Promise.resolve(undefined)
            },
        })

        await samCliConfig.initialize()

        assert.strictEqual(timesCalled, 1)
    })

    it('location provider detects a file', async function () {
        const fakeCliLocation = path.join(tempFolder, 'fakeSamCli')

        const samCliConfig: SamCliConfiguration = new DefaultSamCliConfiguration(settingsConfiguration, {
            getLocation: async (): Promise<string | undefined> => {
                return Promise.resolve(fakeCliLocation)
            },
        })

        await samCliConfig.initialize()

        assert.strictEqual(samCliConfig.getSamCliLocation(), fakeCliLocation)
    })

    it('location provider does not detect a file', async function () {
        const samCliConfig: SamCliConfiguration = new DefaultSamCliConfiguration(settingsConfiguration, {
            getLocation: async (): Promise<string | undefined> => {
                return Promise.resolve(undefined)
            },
        })

        await samCliConfig.initialize()

        assert.strictEqual(samCliConfig.getSamCliLocation(), '')
    })

    function createSampleFile(filename: string): void {
        fs.writeFileSync(filename, 'hi')
    }
})
