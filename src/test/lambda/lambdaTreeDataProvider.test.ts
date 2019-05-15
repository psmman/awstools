/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import * as assert from 'assert'
import { RegionNode } from '../../lambda/explorer/regionNode'
import { LambdaTreeDataProvider } from '../../lambda/lambdaTreeDataProvider'
import { AwsContextTreeCollection } from '../../shared/awsContextTreeCollection'
import { MockOutputChannel } from '../mockOutputChannel'
import {
    DEFAULT_TEST_REGION_CODE,
    DEFAULT_TEST_REGION_NAME,
    FakeAwsContext,
    FakeRegionProvider,
    FakeResourceFetcher
} from '../utilities/fakeAwsContext'

describe('LambdaProvider', () => {

    it('displays region nodes with user-friendly region names', async () => {

        const awsContext = new FakeAwsContext()
        const regionProvider = new FakeRegionProvider()
        const awsContextTreeCollection = new AwsContextTreeCollection()
        const resourceFetcher = new FakeResourceFetcher()
        const mockChannel = new MockOutputChannel()

        const lambdaProvider = new LambdaTreeDataProvider(
            awsContext,
            awsContextTreeCollection,
            regionProvider,
            resourceFetcher,
            (path) => { throw new Error('unused') },
            mockChannel
        )

        const treeNodesPromise = lambdaProvider.getChildren()

        assert(treeNodesPromise)
        const treeNodes = await treeNodesPromise
        assert(treeNodes)
        assert.strictEqual(treeNodes.length, 1)

        const regionNode = treeNodes[0] as RegionNode
        assert(regionNode)
        assert.strictEqual(regionNode.regionCode, DEFAULT_TEST_REGION_CODE)
        assert.strictEqual(regionNode.regionName, DEFAULT_TEST_REGION_NAME)
    })
})
