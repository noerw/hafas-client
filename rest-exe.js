'use strict'

const DEBUG = process.env.DEBUG === 'hafas-client'

const Promise = require('pinkie-promise')
const {fetch} = require('fetch-ponyfill')({Promise})
const {stringify} = require('qs')
const {parse: parseContentType} = require('content-type')
const findInTree = require('./lib/find-in-tree')
const randomizeUserAgent = require('./lib/randomize-user-agent')
const {byErrorCode} = require('./lib/rest-exe-errors')
const parseWhen = require('./parse-rest/when')
const parseLine = require('./parse-rest/line')
const parsePolyline = require('./parse-rest/polyline')
const parseHint = require('./parse-rest/hint')
const parseLocation = require('./parse-rest/location')
const formatDate = require('./format-rest/date')
const formatTime = require('./format-rest/time')
const defaultProfile = require('./lib/default-profile')
const dbMgateProfile = require('./p/db')

const isNonEmptyString = str => 'string' === typeof str && str.length > 0

const createRestClient = (profile, token, userAgent) => {
	profile = {
		...defaultProfile,
		...dbMgateProfile,
		parseWhen,
		parseLine,
		parsePolyline,
		parseHint,
		parseLocation,
		formatDate,
		formatTime,
		...profile
	}
	if (!isNonEmptyString(profile.endpoint)) throw new Error('missing profile.endpoint')
	if (!isNonEmptyString(token)) throw new Error('missing token')
	if (!isNonEmptyString(userAgent)) throw new Error('missing userAgent')

	const request = async (method, opt, query = {}) => {
		query = {
			lang: opt.language || 'en',
			...query,
			format: 'json'
		}
		if (DEBUG) console.error(JSON.stringify(query))

		const url = profile.endpoint + method + '?' + stringify({...query, accessId: token})
		const fetchCfg = {
			headers: {
				'accept-encoding': 'gzip, br, deflate',
				'accept': 'application/json',
				'user-agent': randomizeUserAgent(userAgent)
			},
			redirect: 'follow'
		}
		const res = await fetch(url, fetchCfg)

		const cTypeHeader = res.headers.get('content-type')
		const {type: cType} = cTypeHeader ? parseContentType(cTypeHeader) : {}
		const asJSON = cType === 'application/json'
		const body = asJSON ? await res.json() : await res.text()
		if (DEBUG) console.error(asJSON ? JSON.stringify(body) : body)

		if (!res.ok) {
			// todo: parse HTML error messages
			let err = new Error(res.statusText)
			if (asJSON) {
				const {errorCode, errorText} = body
				if (errorCode && byErrorCode[errorCode]) {
					Object.assign(err, byErrorCode[errorCode])
					err.hafasErrorCode = errorCode
					if (errorText) err.hafasErrorMessage = errorText
				} else {
					err = new Error(errorText)
					err.code = errorCode
				}
			} else if (body) err = new Error(body)

			err.statusCode = res.status
			err.endpoint = profile.endpoint
			err.url = url
			err.query = query
			err.fetchCfg = fetchCfg
			throw err
		}

		// todo: sometimes it returns a body without any data
		// e.g. `location.nearbystops` with an invalid `type`

		const mapping = {
			'**.Stops.Stop': 'stops',
			'**.Names.Name': 'products',
		}

		const allMatches = findInTree(Object.keys(mapping))(body)
		for (const [needle, matches] of Object.entries(allMatches)) {
			const newKey = mapping[needle]

			for (const [item, parents] of matches) {
				const grandParent = parents[1]
				grandParent[newKey] = item
			}
		}

		return {profile, opt, res: body}
	}

	const parseLocationsResult = (l, ctx) => {
		if (l.StopLocation) {
			return profile.parseLocation(ctx, {
				type: 'ST', ...l.StopLocation
			})
		}
		if (l.CoordLocation) {
			return profile.parseLocation(ctx, {
				type: 'ADR', ...l.CoordLocation
			})
		}
		return null
	}

	const locations = async (query, opt = {}) => {
		if (!isNonEmptyString(query)) {
			throw new TypeError('query must be a non-empty string.')
		}
		opt = {
			fuzzy: true, // find only exact matches?
			results: 5, // how many search results?
			stops: true, // return stops/stations?
			addresses: true,
			poi: true, // points of interest
			linesOfStops: false, // parse & expose lines at each stop/station?
			...opt
		}

		const ctx = await request('location.name', opt, {
			input: opt.fuzzy ? query + '?' : query,
			maxNo: 3, // todo: opt.results
			type: profile.formatLocationFilter(opt.stops, opt.addresses, opt.poi)
			// todo: `products` with bitmask
			// todo: coordLong, coordLat, radius
			// todo: refineId
		})

		return ctx.res.stopLocationOrCoordLocation
		.map(l => parseLocationsResult(l, ctx))
		.filter(loc => !!loc)
	}

	const nearby = async (location, opt = {}) => {
		const ctx = await request('location.nearbystops', opt, {
			originCoordLat: location.latitude,
			originCoordLong: location.longitude,
			// r: 2000, // radius
			// maxNo: 5, // todo: opt.results
			type: 'SP', // todo: S/P/SP
			// todo: `products` with bitmask
		})

		return ctx.res.stopLocationOrCoordLocation
		.map((l) => {
			const loc = parseLocationsResult(l, ctx)
			if (loc) loc.distance = l.dist
			return loc
		})
		.filter(loc => !!loc)
	}

	const client = {
		locations, nearby,
	}
	Object.defineProperty(client, 'profile', {value: profile})
	return client
}

module.exports = createRestClient
