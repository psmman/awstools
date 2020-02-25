/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync } from 'fs-extra'
import { join } from 'path'
import { Loggable, Logger, LogLevel } from '../shared/logger'

export const testLogOutput = join(__dirname, 'testLog.log')

/**
 * In-memory Logger implementation suitable for use by tests.
 */
export class TestLogger implements Logger {
    private readonly loggedEntries: {
        logLevel: LogLevel
        entry: Loggable
    }[] = []

    public debug(...message: Loggable[]): void {
        this.addLoggedEntries('debug', message)
    }

    public verbose(...message: Loggable[]): void {
        this.addLoggedEntries('verbose', message)
    }

    public info(...message: Loggable[]): void {
        this.addLoggedEntries('info', message)
    }

    public warn(...message: Loggable[]): void {
        this.addLoggedEntries('warn', message)
    }

    public error(...message: Loggable[]): void {
        this.addLoggedEntries('error', message)
    }

    public getLoggedEntries(...logLevels: LogLevel[]): Loggable[] {
        return this.loggedEntries
            .filter(loggedEntry => logLevels.length === 0 || logLevels.indexOf(loggedEntry.logLevel) !== -1)
            .map(loggedEntry => loggedEntry.entry)
    }

    public writeLoggedEntriesToFile(entry: Loggable) {
        appendFileSync(testLogOutput, `${entry}\n`, 'utf8')
    }

    private addLoggedEntries(logLevel: LogLevel, entries: Loggable[]) {
        entries.forEach(entry => {
            this.loggedEntries.push({
                logLevel,
                entry
            })
            this.writeLoggedEntriesToFile(entry)
        })
    }
}
