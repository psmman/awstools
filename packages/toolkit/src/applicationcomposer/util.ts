/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadByContents } from '../shared/cloudformation/cloudformation'

/**
 * Checks whether a template needs to be updated. This is eiter when the template is out of sync, or
 * when at least one of the templates cannot be parsed. Comments and whitespace should not result
 * in a template update.
 */
export async function templateShouldBeUpdated(oldTemplate: string, newTemplate: string) {
    try {
        const oldParsedTemplate = await loadByContents(oldTemplate, false)
        const newParsedTemplate = await loadByContents(newTemplate, false)
        return JSON.stringify(oldParsedTemplate) !== JSON.stringify(newParsedTemplate)
    } catch (e) {
        return true
    }
}
