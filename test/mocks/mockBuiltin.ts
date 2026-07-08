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
import mock = require('mock-require');

/**
 * Registers a mock for a Node.js built-in module under both its bare specifier
 * (e.g. `os`) and its `node:`-prefixed form (e.g. `node:os`). This keeps the
 * mock effective no matter which import form the code under test uses, so the
 * two never drift out of sync.
 *
 * @param {string} name - the built-in module name, without the `node:` prefix
 * @param {Parameters<typeof mock>[1]} impl - the mock implementation to register
 * @returns {void}
 */
export function mockBuiltin(
    name: string,
    impl: Parameters<typeof mock>[1],
): void {
    mock(name, impl);
    mock(`node:${name}`, impl);
}
