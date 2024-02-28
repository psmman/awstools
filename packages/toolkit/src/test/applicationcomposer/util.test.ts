/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { templateShouldBeUpdated } from '../../applicationcomposer/util'
import assert from 'assert'

describe('templateShouldBeUpdated', async function () {
    const before = `
        Resources:
          SomeResource: 
            Key: value`

    it('template has meaningful changes, returns true', async function () {
        const after = `
        Resources:
          SomeResource: 
            Key: value2`

        const result = await templateShouldBeUpdated(before, after)
        assert.strictEqual(result, true)
    })

    it('template cannot be parsed, returns true', async function () {
        const unparseable = `
        Resources:
          SomeResource 
            Key: value`

        const result = await templateShouldBeUpdated(unparseable, unparseable)
        assert.strictEqual(result, true)
    })

    it('template is identical, returns false', async function () {
        const result = await templateShouldBeUpdated(before, before)
        assert.strictEqual(result, false)
    })

    it('template only has whitespace change, returns false', async function () {
        const after = `
        # Some comment
        Resources:
        
          SomeResource: 
            Key: value`
        const result = await templateShouldBeUpdated(before, after)
        assert.strictEqual(result, false)
    })
})
