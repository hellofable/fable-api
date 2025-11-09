import { createPersistentWherebyMeeting } from '../../lib/whereby.js';
import { applyCORS, handlePreflight } from '../../utils/cors.js';

let PocketBaseCtor = null;

async function getPocketBaseCtor() {
	if (!PocketBaseCtor) {
		const mod = await import('pocketbase');
		PocketBaseCtor = mod?.default ?? mod.PocketBase ?? mod;
	}
	return PocketBaseCtor;
}

function decodePocketBaseToken(token) {
	try {
		const [, payload] = token.split('.');
		if (!payload) return null;
		return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
	} catch (error) {
		console.error('[voice/create] Failed to decode PocketBase token', error);
		return null;
	}
}

function escapeFilterValue(value) {
	return String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"');
}

function respond(res, status, payload) {
	return res.status(status).json(payload);
}

export default async function handler(req, res) {
	// Handle CORS preflight
	if (handlePreflight(req, res)) {
		return; // Preflight handled
	}

	// Apply CORS for actual requests
	if (!applyCORS(req, res)) {
		return; // CORS check failed (403 already sent)
	}

	if (req.method !== 'POST') {
		return respond(res, 405, {
			success: false,
			error: 'Method not allowed'
		});
	}

	const authHeader = req.headers.authorization || '';
	if (!authHeader.startsWith('Bearer ')) {
		return respond(res, 401, {
			success: false,
			error: 'Missing Authorization bearer token'
		});
	}

	const token = authHeader.replace('Bearer ', '').trim();
	const tokenPayload = decodePocketBaseToken(token);
	const userId =
		tokenPayload?.recordId ||
		tokenPayload?.id ||
		tokenPayload?.sub ||
		null;

	if (!userId) {
		return respond(res, 401, {
			success: false,
			error: 'Invalid authentication token'
		});
	}

	if (!process.env.WHEREBY_API_KEY) {
		console.error('[voice/create] WHEREBY_API_KEY is not configured');
		return respond(res, 500, {
			success: false,
			error: 'Voice service is not configured'
		});
	}

	const { screenplayId } = req.body || {};
	const normalizedId = String(screenplayId ?? '').trim();
	if (!normalizedId) {
		return respond(res, 400, {
			success: false,
			error: 'screenplayId is required'
		});
	}

	let pb;
	try {
		const PocketBase = await getPocketBaseCtor();
		pb = new PocketBase(process.env.POCKETBASE_URL);
		pb.authStore.save(token, null);

		let scriptRecord = null;
		try {
			const filter = `screenplayId = "${escapeFilterValue(normalizedId)}"`;
			scriptRecord = await pb.collection('scripts').getFirstListItem(filter);
		} catch (error) {
			if (error?.status === 404) {
				scriptRecord = null;
			} else {
				throw error;
			}
		}

		if (scriptRecord?.userId && scriptRecord.userId !== userId) {
			return respond(res, 403, {
				success: false,
				error: 'You do not have permission to manage this screenplay'
			});
		}

		const meeting = await createPersistentWherebyMeeting(normalizedId);
		const issuedAt = new Date().toISOString();

		return respond(res, 200, {
			success: true,
			provider: 'whereby',
			url: meeting.roomUrl,
			hostUrl: meeting.hostRoomUrl,
			roomName: meeting.roomName,
			meetingId: meeting.meetingId,
			startDate: meeting.startDate,
			endDate: meeting.endDate,
			createdAt: issuedAt,
			raw: meeting.raw
		});
	} catch (error) {
		console.error('[voice/create] Failed to create Whereby meeting', error);
		const status = error?.status ?? 500;
		return respond(res, status, {
			success: false,
			error:
				error?.message ||
				'Failed to create voice room'
		});
	} finally {
		if (pb) {
			pb.authStore?.clear?.();
		}
	}
}
