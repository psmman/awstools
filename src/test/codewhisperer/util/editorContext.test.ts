/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as codewhispererClient from '../../../codewhisperer/client/codewhisperer'
import * as EditorContext from '../../../codewhisperer/util/editorContext'
import { createMockTextEditor, createMockClientRequest, resetCodeWhispererGlobalVariables } from '../testUtil'

describe('editorContext', function () {
    beforeEach(function () {
        resetCodeWhispererGlobalVariables()
    })
    describe('extractContextForCodeWhisperer', function () {
        it('Should return expected context', function () {
            const editor = createMockTextEditor('import math\ndef two_sum(nums, target):\n', 'test.py', 'python', 1, 17)
            const actual = EditorContext.extractContextForCodeWhisperer(editor)
            const expected: codewhispererClient.FileContext = {
                filename: 'test.py',
                programmingLanguage: {
                    languageName: 'python',
                },
                leftFileContent: 'import math\ndef two_sum(nums,',
                rightFileContent: ' target):\n',
            }
            assert.deepStrictEqual(actual, expected)
        })

        it('Should return expected context within max char limit', function () {
            const editor = createMockTextEditor(
                'import math\ndef ' + 'a'.repeat(10340) + 'two_sum(nums, target):\n',
                'test.py',
                'python',
                1,
                17
            )
            const actual = EditorContext.extractContextForCodeWhisperer(editor)
            const expected: codewhispererClient.FileContext = {
                filename: 'test.py',
                programmingLanguage: {
                    languageName: 'python',
                },
                leftFileContent: 'import math\ndef aaaaaaaaaaaaa',
                rightFileContent: 'a'.repeat(10240),
            }
            assert.deepStrictEqual(actual, expected)
        })
    })

    describe('getFileName', function () {
        it('Should return expected filename given a document reading test.py', function () {
            const editor = createMockTextEditor('', 'test.py', 'python', 1, 17)
            const actual = EditorContext.getFileName(editor)
            const expected = 'test.py'
            assert.strictEqual(actual, expected)
        })

        it('Should return expected filename for a long filename', function () {
            const editor = createMockTextEditor('', 'a'.repeat(1500), 'python', 1, 17)
            const actual = EditorContext.getFileName(editor)
            const expected = 'a'.repeat(1024)
            assert.strictEqual(actual, expected)
        })
    })

    describe('getProgrammingLanguage should return expected programming language', function () {
        it('python', function () {
            testGetProgrammingLanguageUtil('test.py', 'python', 'python')
        })

        it('java', function () {
            testGetProgrammingLanguageUtil('test.java', 'java', 'java')
        })

        it('javascript', function () {
            testGetProgrammingLanguageUtil('test.js', 'javascript', 'javascript')
        })

        it('jsx', function () {
            testGetProgrammingLanguageUtil('test.jsx', 'javascriptreact', 'javascript')
        })

        it('typescript', function () {
            testGetProgrammingLanguageUtil('test.ts', 'typescript', 'javascript')
        })

        function testGetProgrammingLanguageUtil(fileName: string, language: string, expected: string) {
            const editor = createMockTextEditor('', fileName, language)
            const actual = EditorContext.getProgrammingLanguage(editor)
            assert.deepStrictEqual(actual.languageName, expected)
        }
    })

    describe('validateRequest', function () {
        it('Should return false if request filename.length is invalid', function () {
            const req = createMockClientRequest()
            req.fileContext.filename = ''
            assert.ok(!EditorContext.validateRequest(req))
        })

        it('Should return false if request programming language is invalid', function () {
            const req = createMockClientRequest()
            req.fileContext.programmingLanguage.languageName = ''
            assert.ok(!EditorContext.validateRequest(req))
            req.fileContext.programmingLanguage.languageName = 'a'.repeat(200)
            assert.ok(!EditorContext.validateRequest(req))
        })

        it('Should return false if request left or right context exceeds max length', function () {
            const req = createMockClientRequest()
            req.fileContext.leftFileContent = 'a'.repeat(256000)
            assert.ok(!EditorContext.validateRequest(req))
            req.fileContext.leftFileContent = 'a'
            req.fileContext.rightFileContent = 'a'.repeat(256000)
            assert.ok(!EditorContext.validateRequest(req))
        })

        it('Should return true if above conditions are not met', function () {
            const req = createMockClientRequest()
            assert.ok(EditorContext.validateRequest(req))
        })
    })

    describe('getLeftContext', function () {
        it('Should return expected left context', function () {
            const editor = createMockTextEditor('import math\ndef two_sum(nums, target):\n', 'test.py', 'python', 1, 17)
            const actual = EditorContext.getLeftContext(editor, 1)
            const expected = '...wo_sum(nums, target)'
            assert.strictEqual(actual, expected)
        })
    })
})
