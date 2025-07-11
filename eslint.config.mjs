/*!
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
import typescriptEslintEslintPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [...compat.extends(
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
), {
    plugins: {
        "@typescript-eslint": typescriptEslintEslintPlugin,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 5,
        sourceType: "module",

        parserOptions: {
            project: "tsconfig.json",
        },
    },

    rules: {
        "@typescript-eslint/interface-name-prefix": "off",
        "@typescript-eslint/explicit-function-return-type": ["warn"],
        "@typescript-eslint/explicit-module-boundary-types": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unsafe-assignment": "warn",
        "@typescript-eslint/no-unsafe-argument": "warn",
        "no-trailing-spaces": "warn",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": ["warn"],
        "semi": ["warn", "always"],

        "no-console": ["warn", {
            allow: ["warn", "error", "info"],
        }],

        "no-debugger": "error",
        "arrow-parens": ["warn", "as-needed"],

        "quotes": ["error", "single", {
            avoidEscape: true,
            allowTemplateLiterals: true,
        }],

        "comma-dangle": ["warn", {
            arrays: "always-multiline",
            objects: "always-multiline",
            imports: "always-multiline",
            exports: "always-multiline",
            functions: "always-multiline",
        }],

        "max-len": ["warn", {
            code: 80,
            ignoreComments: true,
            ignoreRegExpLiterals: true,
            ignoreTrailingComments: true,
            ignoreTemplateLiterals: true,
            ignoreStrings: true,
            ignoreUrls: true,
        }],
    },
}];
