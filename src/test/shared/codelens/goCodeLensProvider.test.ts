/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs-extra'
import * as vscode from 'vscode'

import { writeFile } from 'fs-extra'
import { isValidFuncSignature } from '../../../shared/codelens/goCodeLensProvider'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'

describe('getLambdaHandlerCandidates', async function () {
    let tempFolder: string
    let programFile: string
    let dummyMod: string

    before(async function () {
        // Make a temp folder for all these tests
        tempFolder = await makeTemporaryToolkitFolder('golenstest')
        programFile = path.join(tempFolder, 'program.go')
        dummyMod = path.join(tempFolder, 'go.mod')

        await writeFile(programFile, getFunctionText())
        await writeFile(dummyMod, 'require github.com/aws/aws-lambda-go v1.13.3\nmodule hello-world\ngo 1.14')
    })

    after(async function () {
        await fs.remove(tempFolder)
    })

    it('Detects only good function symbols from a mock program', async function () {
        const textDoc: vscode.TextDocument = await vscode.workspace.openTextDocument(programFile)
        const candidates: vscode.DocumentSymbol[] = getDocumentSymbols().filter(symbol =>
            isValidFuncSignature(textDoc, symbol)
        )

        assert.ok(candidates)
        assert.strictEqual(candidates.length, 2, 'Expected two Lambda Handler components')
        assert.strictEqual(candidates[0].name, 'handler', 'Unexpected handler name')
        assert.strictEqual(candidates[1].name, 'multiLine', 'Unexpected handler name')
    })
})

/**
 * Generates DocumentSymbols that would be generated by the Go language server.
 */
export function getDocumentSymbols(): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = []

    const badFuncSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'notAHandler',
        '()',
        vscode.SymbolKind.Function,
        new vscode.Range(38, 4, 41, 4),
        new vscode.Range(38, 9, 38, 20)
    )
    symbols.push(badFuncSymbol)

    const goodFuncSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'handler',
        '(request events.APIGatewayProxyRequest)',
        vscode.SymbolKind.Function,
        new vscode.Range(23, 0, 51, 0),
        new vscode.Range(23, 5, 23, 12)
    )
    symbols.push(goodFuncSymbol)

    const mainSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'main',
        '()',
        vscode.SymbolKind.Function,
        new vscode.Range(52, 0, 55, 0),
        new vscode.Range(52, 5, 52, 9)
    )
    symbols.push(mainSymbol)

    const manyArgsSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'tooManyArgs',
        '(a, b, c int)',
        vscode.SymbolKind.Function,
        new vscode.Range(56, 0, 59, 0),
        new vscode.Range(56, 5, 56, 16)
    )
    symbols.push(manyArgsSymbol)

    const multiLineSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'multiLine',
        '(a int, b string)',
        vscode.SymbolKind.Function,
        new vscode.Range(60, 0, 64, 0),
        new vscode.Range(60, 5, 60, 14)
    )
    symbols.push(multiLineSymbol)

    const manyReturnSymbol: vscode.DocumentSymbol = new vscode.DocumentSymbol(
        'tooManyReturns',
        '(a int, b int)',
        vscode.SymbolKind.Function,
        new vscode.Range(65, 0, 68, 0),
        new vscode.Range(65, 5, 65, 19)
    )
    symbols.push(manyReturnSymbol)

    return symbols
}

/**
 * Emits file contents from the stock SAM CLI app for Go with some additional functions to test.
 */
export function getFunctionText(): string {
    return String.raw`
package main

import (
    "errors"
    "fmt"
    "io/ioutil"
    "net/http"

    "github.com/aws/aws-lambda-go/events"
    "github.com/aws/aws-lambda-go/lambda"
)

var (
    // DefaultHTTPGetAddress Default Address
    DefaultHTTPGetAddress = "https://checkip.amazonaws.com"

    // ErrNoIP No IP found in response
    ErrNoIP = errors.New("No IP in HTTP response")

    // ErrNon200Response non 200 status code in response
    ErrNon200Response = errors.New("Non 200 Response found")
)

func handler(request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
    resp, err := http.Get(DefaultHTTPGetAddress)
    if err != nil {
        return events.APIGatewayProxyResponse{}, err
    }

    if resp.StatusCode != 200 {
        return events.APIGatewayProxyResponse{}, ErrNon200Response
    }

    ip, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        return events.APIGatewayProxyResponse{}, err
    }

    func notAHandler() int {
        return 0
    }

    if len(ip) == 0 {
        return events.APIGatewayProxyResponse{}, ErrNoIP
    }

    return events.APIGatewayProxyResponse{
        Body:       fmt.Sprintf("Hello, %v", string(ip)),
        StatusCode: 200,
    }, nil
}

func main() {
    lambda.Start(handler)
}    

func tooManyArgs(a, b, c int) {

}

func multiLine(c Context, // this parameter is a context
               s string) /* this parameter is a string */ error {
    return 1
}

func tooManyReturns(a int, b int) (x, y, z string) {

}
`
}
