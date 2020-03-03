/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as path from 'path'
import * as vscode from 'vscode'

import { CloudFormationTemplateRegistry, TemplateData } from '../../../shared/cloudformation/templateRegistry'
import { rmrf } from '../../../shared/filesystem'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'
import { assertThrowsError } from '../utilities/assertUtils'
import { badYaml, makeSampleSamTemplateYaml, strToYamlFile } from './cloudformationTestUtils'

describe.only('CloudFormation Template Registry', async () => {
    const goodYaml1 = makeSampleSamTemplateYaml(false)
    const goodYaml2 = makeSampleSamTemplateYaml(true)

    describe('CloudFormationTemplateRegistry', async () => {
        const testRegistry: CloudFormationTemplateRegistry = CloudFormationTemplateRegistry.getRegistry()
        let tempFolder: string

        beforeEach(async () => {
            tempFolder = await makeTemporaryToolkitFolder()
            testRegistry.reset()
        })

        afterEach(async () => {
            await rmrf(tempFolder)
        })

        describe('addTemplateToRegistry', async () => {
            it("adds data from a template to the registry and can receive the template's data", async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(filename)

                assert.strictEqual(testRegistry.registeredTemplates.length, 1)

                const data = testRegistry.getRegisteredTemplate(filename.fsPath)

                assertValidTestTemplate(data, filename.fsPath)
            })

            it('throws an error if the file to add is not a CF template', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(badYaml, filename.fsPath)

                await assertThrowsError(
                    async () => await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))
                )
            })
        })

        describe('addTemplatesToRegistry', async () => {
            it("adds data from multiple templates to the registry and can receive the templates' data", async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                const filename2 = vscode.Uri.file(path.join(tempFolder, 'template2.yaml'))
                await strToYamlFile(goodYaml2, filename2.fsPath)
                await testRegistry.addTemplatesToRegistry([filename, filename2])

                assert.strictEqual(testRegistry.registeredTemplates.length, 2)

                const data = testRegistry.getRegisteredTemplate(filename.fsPath)
                const data2 = testRegistry.getRegisteredTemplate(filename2.fsPath)

                assertValidTestTemplate(data, filename.fsPath)
                assertValidTestTemplate(data2, filename2.fsPath)
            })

            it('swallows errors if a template is not parseable while still parsing valid YAML', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                const badFilename = vscode.Uri.file(path.join(tempFolder, 'template2.yaml'))
                await strToYamlFile(badYaml, badFilename.fsPath)
                await testRegistry.addTemplatesToRegistry([filename, badFilename])

                assert.strictEqual(testRegistry.registeredTemplates.length, 1)

                const data = testRegistry.getRegisteredTemplate(filename.fsPath)

                assertValidTestTemplate(data, filename.fsPath)
            })
        })

        describe('registeredTemplates', async () => {
            it('returns an empty array if the registry has no registered templates', () => {
                assert.strictEqual(testRegistry.registeredTemplates.length, 0)
            })

            it('returns an populated array if the registry has a registered template', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(filename)
                assert.strictEqual(testRegistry.registeredTemplates.length, 1)
            })

            it('returns an populated array if the registry has multiple registered templates', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))

                const filename2 = vscode.Uri.file(path.join(tempFolder, 'template2.yaml'))
                await strToYamlFile(goodYaml2, filename2.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename2.fsPath))

                assert.strictEqual(testRegistry.registeredTemplates.length, 2)
            })
        })

        describe('getRegisteredTemplate', async () => {
            it('returns undefined if the registry has no registered templates', () => {
                assert.strictEqual(testRegistry.getRegisteredTemplate('template.yaml'), undefined)
            })

            it('returns undefined if the registry does not contain the template in question', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))

                assert.strictEqual(testRegistry.getRegisteredTemplate('not-the-template.yaml'), undefined)
            })

            it('returns a template if the registry has registered said template', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))

                assert.ok(testRegistry.getRegisteredTemplate(filename.fsPath))
            })
        })

        describe('removeTemplateFromRegistry', async () => {
            it('removes an added template', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))
                assert.strictEqual(testRegistry.registeredTemplates.length, 1)

                testRegistry.removeTemplateFromRegistry(vscode.Uri.file(filename.fsPath))
                assert.strictEqual(testRegistry.registeredTemplates.length, 0)
            })

            it('does not affect the registry if a nonexistant template is removed', async () => {
                const filename = vscode.Uri.file(path.join(tempFolder, 'template.yaml'))
                await strToYamlFile(goodYaml1, filename.fsPath)
                await testRegistry.addTemplateToRegistry(vscode.Uri.file(filename.fsPath))
                assert.strictEqual(testRegistry.registeredTemplates.length, 1)

                testRegistry.removeTemplateFromRegistry(vscode.Uri.file(path.join(tempFolder, 'wrong-template.yaml')))
                assert.strictEqual(testRegistry.registeredTemplates.length, 1)
            })
        })
    })
})

function assertValidTestTemplate(data: TemplateData | undefined, filename: string): void {
    assert.ok(data)
    if (data) {
        assert.strictEqual(data.templatePath, filename)
        assert.ok(data.templateData.Resources?.TestResource)
    }
}
