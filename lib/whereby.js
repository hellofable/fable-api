const DEFAULT_BASE_URL = process.env.WHEREBY_API_BASE_URL || 'https://api.whereby.dev';
const MEETINGS_PATH = '/v1/meetings';

function requireApiKey(apiKey) {
	if (!apiKey) {
		const error = new Error('WHEREBY_API_KEY is not configured');
		error.code = 'MISSING_API_KEY';
		throw error;
	}
}

function normalizeBaseUrl(baseUrl) {
	const url = (baseUrl || DEFAULT_BASE_URL).trim();
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function sanitizeRoomPrefix(scriptId) {
	const raw = String(scriptId ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');

	const base = raw || 'screenplay';
	const MAX_LENGTH = 39;
	const prefix = 'fable';
	const remaining = Math.max(1, MAX_LENGTH - prefix.length);
	const truncated = base.slice(0, remaining);
	return `${prefix}${truncated}`;
}

export async function createPersistentWherebyMeeting(scriptId, options = {}) {
	const { apiKey = process.env.WHEREBY_API_KEY, baseUrl = process.env.WHEREBY_API_BASE_URL } = options;
	requireApiKey(apiKey);

	const endpoint = `${normalizeBaseUrl(baseUrl)}${MEETINGS_PATH}`;
	const now = new Date();
	const endDate = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365 * 2); // ~2 years

	const payload = {
		isLocked: false,
		roomNamePrefix: sanitizeRoomPrefix(scriptId),
		startDate: now.toISOString(),
		endDate: endDate.toISOString()
	};

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify(payload)
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		const error = new Error(`Whereby API request failed with status ${response.status}`);
		error.status = response.status;
		error.body = body;
		throw error;
	}

	const meeting = await response.json();
	return {
		raw: meeting,
		roomUrl:
			meeting?.roomUrl ||
			meeting?.meetingRoomUrl ||
			meeting?.meetingUrl ||
			null,
		hostRoomUrl: meeting?.hostRoomUrl || null,
		roomName: meeting?.roomName || null,
		meetingId: meeting?.meetingId || meeting?.roomId || null,
		startDate: meeting?.startDate || null,
		endDate: meeting?.endDate || null
	};
}
