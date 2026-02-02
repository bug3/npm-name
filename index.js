import isUrl from 'is-url-superb';
import ky from 'ky';
import isScoped from 'is-scoped';
import registryUrl from 'registry-url';
import registryAuthToken from 'registry-auth-token';
import zip from 'lodash.zip';
import validate from 'validate-npm-package-name';
import orgRegex from 'org-regex';
import pMap from 'p-map';

const configuredRegistryUrl = registryUrl();
const organizationRegex = orgRegex({exact: true});

// Ensure the URL always ends in a `/`
const normalizeUrl = url => url.replace(/\/$/, '') + '/';

const npmOrganizationUrl = 'https://registry.npmjs.org/-/org/';

// Npm blocks publishing packages whose names differ from existing ones only by punctuation.
// https://blog.npmjs.org/post/168978377570/new-package-moniker-rules.html
const removePunctuation = name => name.replaceAll(/[-._]/g, '');

const hasPunctuationConflict = async (name, {isOrganization, isScopedPackage, registryUrl, headers}) => {
	if (isOrganization || isScopedPackage) {
		return false;
	}

	const lowercaseName = name.toLowerCase();
	const normalizedName = removePunctuation(lowercaseName);
	if (normalizedName === lowercaseName) {
		return false;
	}

	try {
		await ky.head(registryUrl + normalizedName, {timeout: 10_000, headers});
		return true;
	} catch {
		return false;
	}
};

const request = async (name, options) => {
	const registryUrl = normalizeUrl(options.registryUrl ?? configuredRegistryUrl);

	const isOrganization = organizationRegex.test(name);
	if (isOrganization) {
		name = name.replaceAll(/[@/]/g, '');
	}

	const isValid = validate(name);
	if (!isValid.validForNewPackages) {
		const notices = [...isValid.warnings ?? [], ...isValid.errors ?? []].map(v => `- ${v}`);
		notices.unshift(`Invalid package name: ${name}`);
		const error = new InvalidNameError(notices.join('\n'));
		error.warnings = isValid.warnings;
		error.errors = isValid.errors;
		throw error;
	}

	let urlName = name;
	const isScopedPackage = isScoped(name);
	if (isScopedPackage) {
		urlName = name.replaceAll('/', '%2f');
	}

	const authInfo = registryAuthToken(registryUrl, {recursive: true});
	const headers = {};
	if (authInfo && !isOrganization) {
		headers.authorization = `${authInfo.type} ${authInfo.token}`;
	}

	try {
		let packageUrl = registryUrl + urlName.toLowerCase();
		if (isOrganization) {
			packageUrl = npmOrganizationUrl + urlName.toLowerCase() + '/package';
		}

		await ky.head(packageUrl, {timeout: 10_000, headers});
		return false;
	} catch (error) {
		const statusCode = error.response?.status ?? 500;

		if (statusCode === 404) {
			if (await hasPunctuationConflict(name, {
				isOrganization, isScopedPackage, registryUrl, headers,
			})) {
				return false;
			}

			return true;
		}

		if (isScopedPackage && statusCode === 401) {
			return true;
		}

		throw error;
	}
};

export default async function npmName(name, options = {}) {
	if (!(typeof name === 'string' && name.length > 0)) {
		throw new Error('Package name required');
	}

	if (options.registryUrl !== undefined && !(typeof options.registryUrl === 'string' && isUrl(options.registryUrl))) {
		throw new Error('The `registryUrl` option must be a valid string URL');
	}

	return request(name, options);
}

export async function npmNameMany(names, options = {}) {
	if (!Array.isArray(names)) {
		throw new TypeError(`Expected an array of names, got ${typeof names}`);
	}

	if (options.registryUrl !== undefined && !(typeof options.registryUrl === 'string' && isUrl(options.registryUrl))) {
		throw new Error('The `registryUrl` option must be a valid string URL');
	}

	const result = await pMap(names, name => request(name, options), {stopOnError: false});
	return new Map(zip(names, result));
}

export class InvalidNameError extends Error {}
