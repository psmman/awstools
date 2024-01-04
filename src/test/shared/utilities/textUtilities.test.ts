/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import {
    getRelativeDate,
    getStringHash,
    removeAnsi,
    truncate,
    truncateProps,
    indent,
} from '../../../shared/utilities/textUtilities'

describe('textUtilities', async function () {
    it('truncateProps()', async function () {
        const testObj = {
            a: 34234234234,
            b: '123456789',
            c: new Date(2023, 1, 1),
            d: '123456789_abcdefg_ABCDEFG',
            e: {
                e1: [4, 3, 7],
                e2: 'loooooooooo \n nnnnnnnnnnn \n gggggggg \n string',
            },
            f: () => {
                throw Error()
            },
        }
        const expected = {
            ...testObj,
            e: {
                e1: [...testObj.e.e1],
                e2: testObj.e.e2,
            },
        }

        assert.deepStrictEqual(truncateProps(testObj, 25), expected)
        assert.deepStrictEqual(truncateProps(testObj, 3, ['b']), {
            ...expected,
            b: '123…',
        })
        // Assert that original object didn't change.
        assert.deepStrictEqual(truncateProps(testObj, 25), expected)

        assert.deepStrictEqual(truncateProps(testObj, 3, ['a', 'b', 'd', 'f']), {
            ...expected,
            b: '123…',
            d: '123…',
        })
    })

    it('truncate()', async function () {
        assert.deepStrictEqual(truncate('abc 123', 3), 'abc…')
        assert.deepStrictEqual(truncate('abc 123', -3), '…123')
        assert.deepStrictEqual(truncate('abc 123', 1), 'a…')
        assert.deepStrictEqual(truncate('abc 123', -1), '…3')
        assert.deepStrictEqual(truncate('abc 123', 0), '…')
        assert.deepStrictEqual(truncate('abc 123', 99), 'abc 123')
        assert.deepStrictEqual(truncate('abc 123', -99), 'abc 123')
    })

    it('indent()', async function () {
        assert.deepStrictEqual(indent('abc\n123', 2, false), '  abc\n  123')
        assert.deepStrictEqual(indent('abc\n 123\n', 2, false), '  abc\n   123\n')
        assert.deepStrictEqual(indent('abc\n 123\n', 2, true), '  abc\n  123\n')
        assert.deepStrictEqual(indent('   abc\n\n  \n123\nfoo\n', 4, false), '       abc\n\n      \n    123\n    foo\n')
        assert.deepStrictEqual(indent('   abc\n\n    \n123\nfoo\n', 4, true), '    abc\n\n    \n    123\n    foo\n')
    })
})

describe('removeAnsi', async function () {
    it('removes ansi code from text', async function () {
        assert.strictEqual(removeAnsi('\u001b[31mHello World'), 'Hello World')
    })

    it('text without ansi code remains as-is', async function () {
        const text = 'Hello World 123!'
        assert.strictEqual(removeAnsi(text), text)
    })
})

describe('getStringHash', async function () {
    it('produces a hash', async function () {
        assert.ok(getStringHash('hello'))
    })

    it('produces a different hash for different strings', async function () {
        assert.notStrictEqual(getStringHash('hello'), getStringHash('hello '))
    })
})

describe('getRelativeDate', function () {
    const now = new Date(2020, 4, 4, 4, 4, 4) // adjusts for clock skew modifier in `getRelativeDate` fn.
    it('produces readable dates', function () {
        const years = getRelativeDate(new Date(2018, 4, 4, 4, 4, 9), now)
        const year = getRelativeDate(new Date(2019, 4, 4, 4, 4, 9), now)
        const months = getRelativeDate(new Date(2019, 5, 4, 4, 4, 9), now)
        const month = getRelativeDate(new Date(2020, 3, 4, 4, 4, 9), now)
        const weeks = getRelativeDate(new Date(2020, 3, 9, 4, 4, 9), now)
        const week = getRelativeDate(new Date(2020, 3, 27, 4, 4, 9), now)
        const days = getRelativeDate(new Date(2020, 4, 2, 4, 4, 9), now)
        const day = getRelativeDate(new Date(2020, 4, 3, 4, 4, 9), now)
        const hour = getRelativeDate(new Date(2020, 4, 4, 3, 4, 9), now)
        const minute = getRelativeDate(new Date(2020, 4, 4, 4, 3, 9), now)

        assert.strictEqual(years, '2 years ago')
        assert.strictEqual(year, 'last year')
        assert.strictEqual(months, '11 months ago')
        assert.strictEqual(month, 'last month')
        assert.strictEqual(weeks, '4 weeks ago')
        assert.strictEqual(week, 'last week')
        assert.strictEqual(days, '2 days ago')
        assert.strictEqual(day, 'yesterday')
        assert.strictEqual(hour, '1 hour ago')
        assert.strictEqual(minute, '1 minute ago')
    })
})
