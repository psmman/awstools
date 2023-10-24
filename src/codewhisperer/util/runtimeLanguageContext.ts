/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { CodewhispererLanguage } from '../../shared/telemetry/telemetry.gen'
import { createConstantMap, ConstantMap } from '../../shared/utilities/tsUtils'
import * as codewhispererClient from '../client/codewhisperer'
import * as CodeWhispererConstants from '../models/constants'

export class RuntimeLanguageContext {
    /**
     * Key: Union set of CodewhispererLanguageId and PlatformLanguageId (VSC, C9 etc.)
     * Value: CodeWhispererLanguageId
     */
    private supportedLanguageMap: ConstantMap<
        CodeWhispererConstants.PlatformLanguageId | CodewhispererLanguage,
        CodewhispererLanguage
    >

    /**
     * A map storing CodeWhisperer supported programming language with key: vscLanguageId and value: language extension
     * Key: vscLanguageId
     * Value: language extension
     */
    private supportedLanguageExtensionMap: ConstantMap<CodewhispererLanguage, string>

    constructor() {
        this.supportedLanguageMap = createConstantMap<
            CodeWhispererConstants.PlatformLanguageId | CodewhispererLanguage,
            CodewhispererLanguage
        >({
            java: 'java',
            python: 'python',
            javascriptreact: 'jsx',
            javascript: 'javascript',
            typescript: 'typescript',
            typescriptreact: 'tsx',
            csharp: 'csharp',
            c: 'c',
            c_cpp: 'cpp',
            cpp: 'cpp',
            go: 'go',
            kotlin: 'kotlin',
            php: 'php',
            ruby: 'ruby',
            rust: 'rust',
            scala: 'scala',
            sh: 'shell',
            shellscript: 'shell',
            sql: 'sql',
            shell: 'shell',
            jsx: 'jsx',
            tsx: 'tsx',
            plaintext: 'plaintext',
        })
        this.supportedLanguageExtensionMap = createConstantMap<CodewhispererLanguage, string>({
            java: 'java',
            python: 'py',
            jsx: 'jsx',
            javascript: 'js',
            typescript: 'ts',
            tsx: 'tsx',
            csharp: 'cs',
            c: 'c',
            cpp: 'cpp',
            go: 'go',
            kotlin: 'kt',
            php: 'php',
            ruby: 'rb',
            rust: 'rs',
            scala: 'scala',
            shell: 'sh',
            sql: 'sql',
            plaintext: 'txt',
        })
    }

    /**
     * Only used when invoking CodeWhisperer service API, for telemetry usage please use mapToCodewhispererLanguage
     */
    public mapToCodeWhispererRuntimeLanguage(language: CodewhispererLanguage): CodewhispererLanguage {
        switch (language) {
            case 'jsx':
                return 'javascript'

            case 'tsx':
                return 'typescript'

            default:
                return language
        }
    }

    /**
     * To add a new platform language id:
     * 1. add new platform language ID constant in the file codewhisperer/constant.ts
     * 2. add corresponding CodeWhispererLanguageId mapping in the constructor of RuntimeLanguageContext
     * @param languageId : arbitrary string denoting a specific programming language, e.g. CodewhispererLanguageId or PlatformLanguageId
     * @returns corresponding CodewhispererLanguage ID if any, otherwise undefined
     */
    public mapToCodewhispererLanguage(languageId?: string): CodewhispererLanguage | undefined {
        return this.supportedLanguageMap.get(languageId)
    }

    /**
     * This is for notebook files map to a new filename with the corresponding language extension
     * @param languageId : arbitrary string denoting a specific programming language, e.g. CodewhispererLanguageId or PlatformLanguageId
     * @returns corresponding language extension if any, otherwise undefined
     */
    public getLanguageExtensionForNotebook(languageId?: string): string | undefined {
        return this.supportedLanguageExtensionMap.get(this.mapToCodewhispererLanguage(languageId)) ?? undefined
    }

    /**
     * @param vscLanguageId : official vscode languageId
     * @returns An object with a field language: CodewhispererLanguage, if no corresponding CodewhispererLanguage ID, plaintext is returned
     */
    public getLanguageContext(vscLanguageId?: string): { language: CodewhispererLanguage } {
        return { language: this.mapToCodewhispererLanguage(vscLanguageId) ?? 'plaintext' }
    }

    /**
     * Mapping the field ProgrammingLanguage of codewhisperer generateRecommendationRequest | listRecommendationRequest to
     * its Codewhisperer runtime language e.g. jsx -> typescript, typescript -> typescript
     * @param request : cwspr generateRecommendationRequest | ListRecommendationRequest
     * @returns request with source language name mapped to cwspr runtime language
     */
    public mapToRuntimeLanguage<
        T extends codewhispererClient.ListRecommendationsRequest | codewhispererClient.GenerateRecommendationsRequest
    >(request: T): T {
        const fileContext = request.fileContext
        const runtimeLanguage: codewhispererClient.ProgrammingLanguage = {
            languageName: this.mapToCodeWhispererRuntimeLanguage(
                request.fileContext.programmingLanguage.languageName as CodewhispererLanguage
            ),
        }

        return {
            ...request,
            fileContext: {
                ...fileContext,
                programmingLanguage: runtimeLanguage,
            },
        }
    }

    /**
     *
     * @param languageId: either vscodeLanguageId or CodewhispererLanguage
     * @returns ture if the language is supported by CodeWhisperer otherwise false
     */
    public isLanguageSupported(languageId: string): boolean {
        const lang = this.mapToCodewhispererLanguage(languageId)
        return lang !== undefined && this.mapToCodewhispererLanguage(languageId) !== 'plaintext'
    }
}

export const runtimeLanguageContext = new RuntimeLanguageContext()
