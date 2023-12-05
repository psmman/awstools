/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { GoDependencyGraph } from '../../../../codewhisperer/util/dependencyGraph/goDependencyGraph'
import * as CodeWhispererConstants from '../../../../codewhisperer/models/constants'
import assert from 'assert'
import { join } from 'path'
import sinon from 'sinon'
import fs from 'fs'
import { createMockDirentFile } from '../../testUtil'
import { getTestWorkspaceFolder } from '../../../../testInteg/integrationTestsUtilities'

describe('goDependencyGraph', () => {
    const workspaceFolder = getTestWorkspaceFolder()
    const appRoot = join(workspaceFolder, 'go1-zip')
    const appCodePath = join(appRoot, 'main.go')
    const goDependencyGraph = new GoDependencyGraph('go' satisfies CodeWhispererConstants.PlatformLanguageId)

    describe('parseImport', () => {
        beforeEach(() => {
            sinon.stub(fs, 'existsSync').returns(true)
            sinon.stub(fs, 'readdirSync').returns([createMockDirentFile('file1.go'), createMockDirentFile('file2.go')])
        })

        afterEach(() => {
            sinon.restore()
        })

        it('should parse direct import', () => {
            const dependencies = goDependencyGraph.parseImport('import "fmt"', ['dirPath1', 'dirPath2'])
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'fmt', 'file1.go'),
                join('dirPath1', 'fmt', 'file2.go'),
                join('dirPath2', 'fmt', 'file1.go'),
                join('dirPath2', 'fmt', 'file2.go'),
            ])
        })

        it('should parse nested import', () => {
            const dependencies = goDependencyGraph.parseImport('import "math/rand"', ['dirPath1', 'dirPath2'])
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'math', 'rand', 'file1.go'),
                join('dirPath1', 'math', 'rand', 'file2.go'),
                join('dirPath2', 'math', 'rand', 'file1.go'),
                join('dirPath2', 'math', 'rand', 'file2.go'),
            ])
        })

        it('should parse grouped import', () => {
            const dependencies = goDependencyGraph.parseImport(
                `
import (
    "fmt"
    "math"
)
          `,
                ['dirPath1', 'dirPath2']
            )
            assert.strictEqual(dependencies.length, 8)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'fmt', 'file1.go'),
                join('dirPath1', 'fmt', 'file2.go'),
                join('dirPath2', 'fmt', 'file1.go'),
                join('dirPath2', 'fmt', 'file2.go'),
                join('dirPath1', 'math', 'file1.go'),
                join('dirPath1', 'math', 'file2.go'),
                join('dirPath2', 'math', 'file1.go'),
                join('dirPath2', 'math', 'file2.go'),
            ])
        })

        it('should parse aliased import', () => {
            const dependencies = goDependencyGraph.parseImport('import m "math"', ['dirPath1', 'dirPath2'])
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'math', 'file1.go'),
                join('dirPath1', 'math', 'file2.go'),
                join('dirPath2', 'math', 'file1.go'),
                join('dirPath2', 'math', 'file2.go'),
            ])
        })

        it('should parse dot import', () => {
            const dependencies = goDependencyGraph.parseImport('import . "math"', ['dirPath1', 'dirPath2'])
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'math', 'file1.go'),
                join('dirPath1', 'math', 'file2.go'),
                join('dirPath2', 'math', 'file1.go'),
                join('dirPath2', 'math', 'file2.go'),
            ])
        })

        it('should parse blank import', () => {
            const dependencies = goDependencyGraph.parseImport('import _ "math"', ['dirPath1', 'dirPath2'])
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'math', 'file1.go'),
                join('dirPath1', 'math', 'file2.go'),
                join('dirPath2', 'math', 'file1.go'),
                join('dirPath2', 'math', 'file2.go'),
            ])
        })

        it('should parse relative import', () => {
            const dependencies = goDependencyGraph.parseImport(
                'import "example.com/module/outerPackage/innerPackage"',
                ['dirPath1', 'dirPath2']
            )
            assert.strictEqual(dependencies.length, 4)
            assert.deepStrictEqual(dependencies, [
                join('dirPath1', 'example.com', 'module', 'outerPackage', 'innerPackage', 'file1.go'),
                join('dirPath1', 'example.com', 'module', 'outerPackage', 'innerPackage', 'file2.go'),
                join('dirPath2', 'example.com', 'module', 'outerPackage', 'innerPackage', 'file1.go'),
                join('dirPath2', 'example.com', 'module', 'outerPackage', 'innerPackage', 'file2.go'),
            ])
        })
    })

    describe('getDependencies', () => {
        it('should return expected dependencies', () => {
            const dependencies = goDependencyGraph.getDependencies(vscode.Uri.parse(appCodePath), [
                'import (\n\t"example/random-number/util"\n\t"fmt"\n)',
            ])
            assert.strictEqual(dependencies.length, 1)
            assert.strictEqual(dependencies[0], join(appRoot, 'util', 'number.go'))
        })
    })

    describe('searchDependency', () => {
        it('should search dependencies and return expected picked source files', async () => {
            const sourceFilesSet = await goDependencyGraph.searchDependency(vscode.Uri.parse(appCodePath))
            assert.strictEqual(sourceFilesSet.size, 3)
            const sourceFiles = [...sourceFilesSet]
            assert.strictEqual(sourceFiles[0], join(appRoot, 'main.go'))
            assert.strictEqual(sourceFiles[1], join(appRoot, 'help.go'))
            assert.strictEqual(sourceFiles[2], join(appRoot, 'util', 'number.go'))
        })
    })

    describe('generateTruncation', () => {
        it('should generate and return expected truncation', async () => {
            const truncation = await goDependencyGraph.generateTruncation(vscode.Uri.file(appCodePath))
            assert.ok(truncation.rootDir.includes(CodeWhispererConstants.codeScanTruncDirPrefix))
            assert.ok(truncation.zipFilePath.includes(CodeWhispererConstants.codeScanTruncDirPrefix))
            assert.ok(truncation.lines > 0)
            assert.ok(truncation.srcPayloadSizeInBytes > 0)
            assert.ok(truncation.scannedFiles.size > 0)
        })
    })

    describe('isTestFile', () => {
        it('should return true if the file contains relevant test imports', async () => {
            const content = `
            package main
            import "testing"

            // your test code goes here`

            const isTestFile = await goDependencyGraph.isTestFile(content)
            assert.strictEqual(isTestFile, true)
        })

        it('should return false if the file does not contain any relevant test imports', async () => {
            const content = `
            package main
            import "fmt"

            // your non-test code goes here`

            const isTestFile = await goDependencyGraph.isTestFile(content)
            assert.strictEqual(isTestFile, false)
        })
    })
})
