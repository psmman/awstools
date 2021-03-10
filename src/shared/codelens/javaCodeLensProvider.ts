/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { LambdaHandlerCandidate } from '../lambdaHandlerSearch'
import { findParentProjectFile } from '../utilities/workspaceUtils'

export const JAVA_LANGUAGE = 'java'
export const JAVA_ALLFILES: vscode.DocumentFilter[] = [
    {
        scheme: 'file',
        language: JAVA_LANGUAGE,
    },
]
export const GRADLE_BASE_PATTERN = '**/build.gradle'
export const MAVEN_BASE_PATTERN = '**/pom.xml'

const REGEXP_RESERVED_WORD_PUBLIC = /\bpublic \b/
const REGEXP_RESERVED_WORD_ABSTRACT = /\b abstract \b/
const REGEXP_PARAMETERS = /\(.*\)/

export interface JavaLambdaHandlerComponents {
    package: string
    class: string
    method: string
    // Range of the function representing the Lambda Handler
    handlerRange: vscode.Range
}

export async function getLambdaHandlerCandidates(document: vscode.TextDocument): Promise<LambdaHandlerCandidate[]> {
    // Limitation: If more than one .csproj file exists in the same directory,
    // and the directory is the closest to the source file, the csproj file used will be random

    // TODO : Perform an XPATH parse on the project file
    // If Project/PropertyGroup/AssemblyName exists, use that. Otherwise use the file name.
    const manifestUri =
        (await findParentProjectFile(document.uri, /^.*pom.xml$/)) ??
        (await findParentProjectFile(document.uri, /^.*build.gradle$/))
    if (!manifestUri) {
        return []
    }

    // TODO make this work?
    const symbols: vscode.DocumentSymbol[] =
        (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) || []

    return getLambdaHandlerComponents(document, symbols).map<LambdaHandlerCandidate>(lambdaHandlerComponents => {
        const handlerName = generateJavaLambdaHandler(lambdaHandlerComponents)

        return {
            filename: document.uri.fsPath,
            handlerName,
            manifestUri: manifestUri,
            range: lambdaHandlerComponents.handlerRange,
        }
    })
}

export function getLambdaHandlerComponents(
    document: vscode.TextDocument,
    symbols: vscode.DocumentSymbol[]
): JavaLambdaHandlerComponents[] {
    const packageSymbols = symbols.filter(symbol => symbol.kind === vscode.SymbolKind.Package)
    if (packageSymbols.length !== 1) {
        return []
    }
    const packageName = packageSymbols[0].name

    return (
        symbols
            .filter(symbol => symbol.kind === vscode.SymbolKind.Class)
            .filter(classSymbol => isValidClassSymbol(document, classSymbol))
            // Find relevant methods within each class
            .reduce<JavaLambdaHandlerComponents[]>((accumulator, lambdaHandlerComponent) => {
                accumulator.push(
                    ...lambdaHandlerComponent.children
                        .filter(classChildSymbol => classChildSymbol.kind === vscode.SymbolKind.Method)
                        .filter(methodSymbol => isValidLambdaHandler(document, methodSymbol))
                        .map(methodSymbol => {
                            return {
                                package: packageName,
                                class: document.getText(lambdaHandlerComponent.selectionRange),
                                method: document.getText(methodSymbol.selectionRange),
                                handlerRange: methodSymbol.range,
                            }
                        })
                )

                return accumulator
            }, [])
    )
}

export function isValidClassSymbol(
    document: Pick<vscode.TextDocument, 'getText'>,
    symbol: vscode.DocumentSymbol
): boolean {
    if (symbol.kind === vscode.SymbolKind.Class) {
        // from "public abstract class Processor" pull "public abstract class "
        const classDeclarationBeforeNameRange = new vscode.Range(symbol.range.start, symbol.selectionRange.start)
        const classDeclarationBeforeName: string = document.getText(classDeclarationBeforeNameRange)

        return (
            REGEXP_RESERVED_WORD_PUBLIC.test(classDeclarationBeforeName) &&
            !REGEXP_RESERVED_WORD_ABSTRACT.test(classDeclarationBeforeName)
        )
    }

    return false
}

/**
 * Returns whether or not a method is a valid Lambda handler
 * @param document VS Code document
 * @param symbol VS Code DocumentSymbol to evaluate
 */
export function isValidLambdaHandler(
    document: Pick<vscode.TextDocument, 'getText'>,
    symbol: vscode.DocumentSymbol
): boolean {
    if (symbol.kind === vscode.SymbolKind.Method) {
        // from "public async Task<Response> foo()" pull "public async Task<Response> "
        const signatureBeforeMethodNameRange = new vscode.Range(symbol.range.start, symbol.selectionRange.start)
        const signatureBeforeMethodName: string = document.getText(signatureBeforeMethodNameRange)

        if (REGEXP_RESERVED_WORD_PUBLIC.test(signatureBeforeMethodName)) {
            return isValidMethodSignature(symbol)
        }
    }

    return false
}

/**
 * Returns whether or not a VS Code DocumentSymbol is a method that could be a Lambda handler
 * * has one parameter
 * * has three or fewer parameters, where the last parameter is a `Context` type
 *   * does not check for extension/implementation of Context, and cannot differentiate between different types of Context objects (just has to be something named `Context`)
 * @param symbol VS Code DocumentSymbol to analyze
 */
export function isValidMethodSignature(symbol: vscode.DocumentSymbol): boolean {
    // TODO: handle different kinds of imported context objects in case user is importing a non-Lambda context
    const lambdaContextType = /[\.\b]{0,1}Context\b/

    if (symbol.kind === vscode.SymbolKind.Method) {
        // The `redhat.java` extension appears to strip a fair amount from this signature:
        // from source function `public APIGatewayProxyResponseEvent handleRequest(final APIGatewayProxyRequestEvent input, final Context context)`
        // redhat extension returns: symbol.name = `'handleRequest(APIGatewayProxyRequestEvent, Context)'`
        const parametersArr = REGEXP_PARAMETERS.exec(symbol.name)
        // reject if there are no parameters
        if (!parametersArr) {
            return false
        }
        // remove generics from parameter string so we can do a predictable split on comma
        const strippedStr = stripGenericsFromParams(parametersArr[0])
        const individualParams = strippedStr.split(',')
        if (
            individualParams.length === 1 ||
            (individualParams.length <= 3 &&
                lambdaContextType.test(individualParams[individualParams.length - 1].valueOf().trimLeft()))
        ) {
            return true
        }
    }

    return false
}

/**
 * Strips any generics from a string in order to ensure predictable commas for a string of parameters.
 * e.g.: `'(Foo<Bar, Baz> x, Context y)' -> '(Foo x, Context y)'`
 * Implements a fairly rough English-centric approximation of the Java identifier spec:
 * * isJavaIdentifierStart(firstCharacter) is true: https://docs.oracle.com/javase/7/docs/api/java/lang/Character.html#isJavaIdentifierStart(char)
 * * all other characters are true for isJavaIdentifierPart: https://docs.oracle.com/javase/7/docs/api/java/lang/Character.html#isJavaIdentifierPart(char)
 *   * For now, cover this from an English-centric point of view (a-zA-Z) and add unicode ranges if necessary
 *
 * @param input String to remove generics from
 */
function stripGenericsFromParams(input: string): string {
    const javaGenericIdentifierRegex = /(?:<{1}(?:\s*[a-zA-Z_$][a-zA-Z0-9_$]*[\s,]?)*>{1})/g

    return input.replace(javaGenericIdentifierRegex, '')
}

/**
 *
 * @param components Components to generate handler from
 * @returns String representation of the Lambda Java handler. Always provides method (even if it corrrectly implements a Java Lambda interface)
 */
export function generateJavaLambdaHandler(components: JavaLambdaHandlerComponents): string {
    return `${components.package}.${components.class}::${components.method}`
}
