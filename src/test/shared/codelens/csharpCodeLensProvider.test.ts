/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import * as sampleDotNetSamProgram from './sampleDotNetSamProgram'

import {
    DotNetHandlerSymbolsTuple,
    findParentProjectFile,
    getLambdaHandlerSymbolsTuples,
    isPublicClassSymbol,
    isPublicMethodSymbol,
    produceHandlerName,
} from '../../../shared/codelens/csharpCodeLensProvider'
import { writeFile } from '../../../shared/filesystem'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'

const fakeRange = new vscode.Range(0, 0, 0, 0)

describe('findParentProjectFile', async () => {
    const sourceCodeUri = vscode.Uri.file(path.join('code', 'someproject', 'src', 'Program.cs'))
    const projectInSameFolderUri = vscode.Uri.file(path.join('code', 'someproject', 'src', 'App.csproj'))
    const projectInParentFolderUri = vscode.Uri.file(path.join('code', 'someproject', 'App.csproj'))
    const projectInParentParentFolderUri = vscode.Uri.file(path.join('code', 'App.csproj'))
    const projectOutOfParentChainUri = vscode.Uri.file(path.join('code', 'someotherproject', 'App.csproj'))

    const testScenarios = [
        {
            scenario: 'locates project in same folder',
            findFilesResult: [projectInSameFolderUri],
            expectedResult: projectInSameFolderUri,
        },
        {
            scenario: 'locates project in parent folder',
            findFilesResult: [projectInParentFolderUri],
            expectedResult: projectInParentFolderUri,
        },
        {
            scenario: 'locates project two parent folders up',
            findFilesResult: [projectInParentParentFolderUri],
            expectedResult: projectInParentParentFolderUri,
        },
        {
            scenario: 'selects project in same folder over parent folder',
            findFilesResult: [projectInSameFolderUri, projectInParentFolderUri],
            expectedResult: projectInSameFolderUri,
        },
        {
            scenario: 'returns undefined when no project files are located',
            findFilesResult: [],
            expectedResult: undefined,
        },
        {
            scenario: 'returns undefined when no project files are located in parent chain',
            findFilesResult: [projectOutOfParentChainUri],
            expectedResult: undefined,
        },
    ]

    testScenarios.forEach((test) => {
        it(test.scenario, async () => {
            const projectFile = await findParentProjectFile(
                sourceCodeUri,
                async (): Promise<vscode.Uri[]> => test.findFilesResult,
            )
            assert.strictEqual(projectFile, test.expectedResult, 'Project file was not the expected one')
        })
    })
})

describe('getLambdaHandlerSymbolsTuples', async () => {
    it('Detects a public function symbol', async () => {
        const folder = await makeTemporaryToolkitFolder()
        const programFile = path.join(folder, 'program.cs')
        await writeFile(programFile, sampleDotNetSamProgram.getFunctionText())

        const textDoc = await vscode.workspace.openTextDocument(programFile)
        const documentSymbols = sampleDotNetSamProgram.getDocumentSymbols()

        const tuples = getLambdaHandlerSymbolsTuples(
            textDoc,
            documentSymbols,
        )

        assert.ok(tuples)
        assert.strictEqual(tuples.length, 1, 'Expected only one Symbols Tuple')
        const tuple = tuples[0]
        assert.strictEqual(tuple.namespace, documentSymbols[0])
        assert.strictEqual(tuple.class, documentSymbols[0].children[0])
        assert.strictEqual(
            tuple.method,
            documentSymbols[0].children[0].children.filter(c => c.name.indexOf('FunctionHandler') === 0)[0]
        )
    })
})

describe('isPublicClassSymbol', async () => {
    const sampleClassSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'HelloWorld.Function',
        '',
        vscode.SymbolKind.Class, fakeRange, fakeRange
    )

    it('returns true for a public class', async () => {
        const doc = {
            getText: (range?: vscode.Range): string => {
                return 'public class Function {}'
            }
        }

        const isPublic = isPublicClassSymbol(doc, sampleClassSymbol)
        assert.strictEqual(isPublic, true, 'Expected symbol to be a public class')
    })

    it('returns false when symbol is not of type Class', async () => {
        const symbol = new vscode.DocumentSymbol(
            sampleClassSymbol.name, sampleClassSymbol.detail, vscode.SymbolKind.Method,
            sampleClassSymbol.range, sampleClassSymbol.selectionRange
        )

        const doc = {
            getText: (range?: vscode.Range): string => {
                return 'public class Function {}'
            }
        }

        const isPublic = isPublicClassSymbol(doc, symbol)
        assert.strictEqual(isPublic, false, 'Expected symbol not to be a public class')
    })

    it('returns false when class is not public', async () => {
        const doc = {
            getText: (range?: vscode.Range): string => 'private class '
        }

        const isPublic = isPublicClassSymbol(doc, sampleClassSymbol)
        assert.strictEqual(isPublic, false, 'Expected symbol not to be a public class')
    })
})

describe('isPublicMethodSymbol', async () => {
    const sampleMethodSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'FunctionHandler(APIGatewayProxyRequest apigProxyEvent, ILambdaContext context)',
        '',
        vscode.SymbolKind.Method, fakeRange, fakeRange
    )

    const validPublicMethodTests = [
        {
            scenario: 'signature all on one line',
            functionSignature: generateFunctionSignature('public', 'FunctionHandler')
        },
        {
            scenario: 'signature across many lines',
            functionSignature: generateFunctionSignature('public', 'FunctionHandler', true, true, true)
        },
        {
            scenario: 'method name on another line',
            functionSignature: generateFunctionSignature('public', 'FunctionHandler', true)
        },
        {
            scenario: 'args on many lines',
            functionSignature: generateFunctionSignature('public', 'FunctionHandler', false, true)
        },
    ]

    validPublicMethodTests.forEach((test) => {
        it(`returns true for a public method symbol when ${test.scenario}`, async () => {
            const doc = {
                getText: (range?: vscode.Range): string =>
                    generateFunctionDeclaration(test.functionSignature)
            }

            const isPublic = isPublicMethodSymbol(doc, sampleMethodSymbol)
            assert.strictEqual(isPublic, true, 'Expected symbol to be a public method')
        })
    })

    it('returns false for a symbol that is not a method', async () => {
        const symbol = new vscode.DocumentSymbol(
            sampleMethodSymbol.name, sampleMethodSymbol.detail, vscode.SymbolKind.Class,
            sampleMethodSymbol.range, sampleMethodSymbol.selectionRange
        )

        const doc = {
            getText: (range?: vscode.Range): string => {
                throw new Error('getText is unused')
            }
        }

        const isPublic = isPublicMethodSymbol(doc, symbol)
        assert.strictEqual(isPublic, false, 'Expected symbol not to be a public method')
    })

    it('returns false when the method is not public', async () => {
        const doc = {
            getText: (range?: vscode.Range): string =>
                generateFunctionDeclaration(generateFunctionSignature('private', 'FunctionHandler'))
        }

        const isPublic = isPublicMethodSymbol(doc, sampleMethodSymbol)
        assert.strictEqual(isPublic, false, 'Expected symbol not to be a public method')
    })

    it('returns false when a private method name contains the word public in it', async () => {
        const symbol = new vscode.DocumentSymbol(
            'notpublicmethod', sampleMethodSymbol.detail, vscode.SymbolKind.Method,
            sampleMethodSymbol.range, sampleMethodSymbol.selectionRange
        )

        const doc = {
            getText: (range?: vscode.Range): string =>
                generateFunctionDeclaration(generateFunctionSignature('private', symbol.name))
        }

        const isPublic = isPublicMethodSymbol(doc, symbol)
        assert.strictEqual(isPublic, false, 'Expected symbol not to be a public method')
    })

    /**
     * Simulates the contents of a TextDocument that corresponds to a Method Symbol's range
     */
    function generateFunctionDeclaration(functionSignature: string): string {
        return `${functionSignature}
        {
            string location = GetCallingIP().Result;
            Dictionary<string, string> body = new Dictionary<string, string>
            {
                { "message", "hello world" },
                { "location", location },
            };

            return new APIGatewayProxyResponse
            {
                Body = JsonConvert.SerializeObject(body),
                StatusCode = 200,
                Headers = new Dictionary<string, string> { { "Content-Type", "application/json" } }
            };
        }
`
    }

    /**
     * Simulates the Function signature portion of the contents of a TextDocument that corresponds
     * to a Method Symbol's range. Used with generateFunctionDeclaration.
     */
    function generateFunctionSignature(
        access: 'public' | 'private',
        functionName: string,
        beforeFunctionName: boolean = false,
        beforeArgument: boolean = false,
        afterSignature: boolean = false,
    ): string {
        const beforeFunctionText = beforeFunctionName ? os.EOL : ''
        const beforeArgumentText = beforeArgument ? os.EOL : ''
        const afterSignatureText = afterSignature ? os.EOL : ''

        // tslint:disable-next-line:max-line-length
        return `${access} APIGatewayProxyResponse ${beforeFunctionText}${functionName}(${beforeArgumentText}APIGatewayProxyRequest apigProxyEvent, ${beforeArgumentText}ILambdaContext context)${afterSignatureText}`
    }
})

describe('produceHandlerName', async () => {
    const assemblyName: string = 'myAssembly'

    it('produces a handler name', async () => {
        const tuple: DotNetHandlerSymbolsTuple = {
            namespace: new vscode.DocumentSymbol('namespace', '', vscode.SymbolKind.Namespace, fakeRange, fakeRange),
            class: new vscode.DocumentSymbol('myClass', '', vscode.SymbolKind.Class, fakeRange, fakeRange),
            className: 'myClass',
            method: new vscode.DocumentSymbol('foo()', '', vscode.SymbolKind.Method, fakeRange, fakeRange),
            methodName: 'foo'
        }

        const handlerName = produceHandlerName(assemblyName, tuple)
        assert.strictEqual(handlerName, 'myAssembly::myClass::foo', 'Handler name mismatch')
    })
})
