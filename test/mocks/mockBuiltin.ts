/*!
 * IMQ Unit Test Mocks: mockBuiltin helper
 *
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import { mock, type MockModuleOptions } from 'node:test';

/**
 * Builds the `mock.module()` options from a single exports shape (`default`
 * key being the default export). The long-standing `defaultExport` /
 * `namedExports` pair is used on every Node version: newer 24.x lines emit a
 * deprecation warning in favor of an `exports` option, but that option's
 * behavior has already shifted between 24.x releases (module mocking is
 * experimental), while the pair keeps working consistently on 22.x and 24.x.
 *
 * Note: named exports are merged onto the default export for CJS consumers,
 * which requires the default export to be a plain object (a bare class as
 * the default with named exports alongside is rejected by the runtime).
 *
 * `cache: true` keeps mock-require's semantics: every `require()` of the
 * mocked specifier returns the same module instance, so a test may patch a
 * property in place and the code under test observes the change.
 *
 * @param {Record<string, unknown>} exports - mock exports, `default` key being
 *                                            the default export
 * @returns {MockModuleOptions}
 */
export function moduleMockOptions(
    exports: Record<string, unknown>,
): MockModuleOptions {
    const { default: defaultExport, ...namedExports } = exports;
    const options: MockModuleOptions = { cache: true };

    if (defaultExport !== undefined) {
        options.defaultExport = defaultExport;
    }

    if (Object.keys(namedExports).length) {
        options.namedExports = namedExports;
    }

    return options;
}

/**
 * Registers a mock for a Node.js built-in module using the native
 * `node:test` module mocking (`--experimental-test-module-mocks` must be
 * enabled). Node resolves the bare specifier (e.g. `os`) and its
 * `node:`-prefixed form (e.g. `node:os`) to the same module, so a single
 * registration keeps the mock effective no matter which import form the code
 * under test uses.
 *
 * @param {string} name - the built-in module name, without the `node:` prefix
 * @param {Record<string, unknown>} impl - the mock exports to register
 * @returns {void}
 */
export function mockBuiltin(name: string, impl: Record<string, unknown>): void {
    mock.module(`node:${name}`, moduleMockOptions(impl));
}
