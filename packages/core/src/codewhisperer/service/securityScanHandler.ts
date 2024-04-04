/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultCodeWhispererClient } from '../client/codewhisperer'
import { getLogger } from '../../shared/logger'
import { AggregatedCodeScanIssue, CodeScansState, codeScanState, CodeScanStoppedError } from '../models/model'
import { sleep } from '../../shared/utilities/timeoutUtils'
import * as codewhispererClient from '../client/codewhisperer'
import * as CodeWhispererConstants from '../models/constants'
import { existsSync, statSync } from 'fs'
import { RawCodeScanIssue } from '../models/model'
import path = require('path')
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import { ArtifactMap, CreateUploadUrlRequest, CreateUploadUrlResponse } from '../client/codewhispereruserclient'
import { TelemetryHelper } from '../util/telemetryHelper'
import request from '../../common/request'
import { ZipMetadata } from '../util/zipUtil'

export async function listScanResults(
    client: DefaultCodeWhispererClient,
    jobId: string,
    codeScanFindingsSchema: string,
    projectPath: string
) {
    const codeScanIssueMap: Map<string, RawCodeScanIssue[]> = new Map()
    const aggregatedCodeScanIssueList: AggregatedCodeScanIssue[] = []
    const requester = (request: codewhispererClient.ListCodeScanFindingsRequest) => client.listCodeScanFindings(request)
    const collection = pageableToCollection(requester, { jobId, codeScanFindingsSchema }, 'nextToken')
    const issues = await collection
        .flatten()
        .map(resp => {
            getLogger().verbose(`Request id: ${resp.$response.requestId}`)
            if ('codeScanFindings' in resp) {
                return resp.codeScanFindings
            }
            return resp.codeAnalysisFindings
        })
        .promise()
    issues.forEach(issue => {
        mapToAggregatedList(codeScanIssueMap, aggregatedCodeScanIssueList, issue, projectPath)
    })
    return aggregatedCodeScanIssueList
}

function mapToAggregatedList(
    codeScanIssueMap: Map<string, RawCodeScanIssue[]>,
    aggregatedCodeScanIssueList: AggregatedCodeScanIssue[],
    json: string,
    projectPath: string
) {
    const codeScanIssues: RawCodeScanIssue[] = JSON.parse(json)
    codeScanIssues.forEach(issue => {
        if (codeScanIssueMap.has(issue.filePath)) {
            const list = codeScanIssueMap.get(issue.filePath)
            if (list === undefined) {
                codeScanIssueMap.set(issue.filePath, [issue])
            } else {
                list.push(issue)
                codeScanIssueMap.set(issue.filePath, list)
            }
        } else {
            codeScanIssueMap.set(issue.filePath, [issue])
        }
    })

    codeScanIssueMap.forEach((issues, key) => {
        const filePath = path.join(projectPath, '..', key)
        if (existsSync(filePath) && statSync(filePath).isFile()) {
            const aggregatedCodeScanIssue: AggregatedCodeScanIssue = {
                filePath: filePath,
                issues: issues.map(issue => {
                    return {
                        startLine: issue.startLine - 1 >= 0 ? issue.startLine - 1 : 0,
                        endLine: issue.endLine,
                        comment: `${issue.title.trim()}: ${issue.description.text.trim()}`,
                        title: issue.title,
                        description: issue.description,
                        detectorId: issue.detectorId,
                        detectorName: issue.detectorName,
                        findingId: issue.findingId,
                        ruleId: issue.ruleId,
                        relatedVulnerabilities: issue.relatedVulnerabilities,
                        severity: issue.severity,
                        recommendation: issue.remediation.recommendation,
                        suggestedFixes: issue.remediation.suggestedFixes,
                    }
                }),
            }
            aggregatedCodeScanIssueList.push(aggregatedCodeScanIssue)
        }
    })
}

export async function pollScanJobStatus(
    client: DefaultCodeWhispererClient,
    jobId: string,
    scanType: CodeWhispererConstants.SecurityScanType
) {
    getLogger().verbose(`Polling scan job status...`)
    let status: string = 'Pending'
    let timer: number = 0
    while (true) {
        throwIfCancelled(scanType)
        const req: codewhispererClient.GetCodeScanRequest = {
            jobId: jobId,
        }
        const resp = await client.getCodeScan(req)
        getLogger().verbose(`Request id: ${resp.$response.requestId}`)
        if (resp.status !== 'Pending') {
            status = resp.status
            getLogger().verbose(`Scan job status: ${status}`)
            getLogger().verbose(`Complete Polling scan job status.`)
            break
        }
        throwIfCancelled(scanType)
        await sleep(CodeWhispererConstants.codeScanJobPollingIntervalSeconds * 1000)
        timer += CodeWhispererConstants.codeScanJobPollingIntervalSeconds
        if (timer > CodeWhispererConstants.codeScanJobTimeoutSeconds) {
            getLogger().verbose(`Scan job status: ${status}`)
            getLogger().verbose(`Scan job timeout.`)
            throw new Error('Scan job timeout.')
        }
    }
    return status
}

export async function createScanJob(
    client: DefaultCodeWhispererClient,
    artifactMap: codewhispererClient.ArtifactMap,
    languageId: string
) {
    getLogger().verbose(`Creating scan job...`)
    const req: codewhispererClient.CreateCodeScanRequest = {
        artifacts: artifactMap,
        programmingLanguage: {
            languageName: languageId,
        },
    }
    const resp = await client.createCodeScan(req)
    getLogger().verbose(`Request id: ${resp.$response.requestId}`)
    TelemetryHelper.instance.sendCodeScanEvent(languageId, resp.$response.requestId)
    return resp
}

export async function getPresignedUrlAndUpload(client: DefaultCodeWhispererClient, zipMetadata: ZipMetadata) {
    const zipBuffer = zipMetadata.zipStreamBuffer.getContents()
    if (!zipBuffer) {
        throw new Error("Zip failure: can't find valid source zip.")
    }
    const srcReq: CreateUploadUrlRequest = {
        contentMd5: zipMetadata.zipMd5,
        artifactType: 'SourceCode',
    }
    getLogger().verbose(`Prepare for uploading src context...`)
    const srcResp = await client.createUploadUrl(srcReq)
    getLogger().verbose(`Request id: ${srcResp.$response.requestId}`)
    getLogger().verbose(`Complete Getting presigned Url for uploading src context.`)
    getLogger().verbose(`Uploading src context...`)
    await uploadArtifactToS3(zipBuffer, srcResp, zipMetadata.zipMd5)
    getLogger().verbose(`Complete uploading src context.`)
    const artifactMap: ArtifactMap = {
        SourceCode: srcResp.uploadId,
    }
    return artifactMap
}

export function throwIfCancelled(scanType: CodeWhispererConstants.SecurityScanType) {
    switch (scanType) {
        case CodeWhispererConstants.SecurityScanType.Project:
            if (codeScanState.isCancelling()) {
                throw new CodeScanStoppedError()
            }
            break
        case CodeWhispererConstants.SecurityScanType.File:
            if (!CodeScansState.instance.isScansEnabled()) {
                throw new CodeScanStoppedError()
            }
            break
        default:
            getLogger().warn(`Unknown scan type: ${scanType}`)
            break
    }
}

export async function uploadArtifactToS3(buffer: Buffer, resp: CreateUploadUrlResponse, md5: string) {
    const encryptionContext = `{"uploadId":"${resp.uploadId}"}`
    const headersObj: Record<string, string> = {
        'Content-MD5': md5,
        'x-amz-server-side-encryption': 'aws:kms',
        'Content-Type': 'application/zip',
        'x-amz-server-side-encryption-context': Buffer.from(encryptionContext, 'utf8').toString('base64'),
    }

    if (resp.kmsKeyArn !== '' && resp.kmsKeyArn !== undefined) {
        headersObj['x-amz-server-side-encryption-aws-kms-key-id'] = resp.kmsKeyArn
    }

    const response = await request.fetch('PUT', resp.uploadUrl, {
        body: buffer,
        headers: headersObj,
    }).response
    getLogger().debug(`StatusCode: ${response.status}, Text: ${response.statusText}`)
}
