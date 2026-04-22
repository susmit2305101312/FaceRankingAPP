import crypto from 'crypto';

// Lazy env getters — reads fresh on each call (important for Vercel serverless)
function getCloudName() { return process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || ''; }
function getUploadPreset() { return process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET || 'face_rank_upload'; }
function getApiKey() { return process.env.CLOUDINARY_API_KEY || ''; }
function getApiSecret() { return process.env.CLOUDINARY_API_SECRET || ''; }
function getCloudinaryUrl() { return `https://api.cloudinary.com/v1_1/${getCloudName()}`; }

/* ─── Types ─── */
export interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  url: string;
  context?: { custom?: Record<string, string> };
  tags?: string[];
}

export interface FaceImage {
  id: string;             // public_id (used as unique id)
  subjectId: string;
  imageId: string;
  cloudinaryUrl: string;
  publicId: string;
  createdAt: string;
}

/* ─── Signature Generation (for Cloudinary Admin API) ─── */
function generateSignature(paramsToSign: string): string {
  return crypto
    .createHash('sha1')
    .update(paramsToSign + getApiSecret())
    .digest('hex');
}

/* ─── Upload (unsigned) with context metadata ─── */
export async function uploadToCloudinary(
  file: File | Buffer,
  filename: string,
  subjectId: string,
  imageId: string
): Promise<CloudinaryUploadResult> {
  const formData = new FormData();

  if (file instanceof File) {
    formData.append('file', file);
  } else {
    const blob = new Blob([file], { type: 'image/jpeg' });
    formData.append('file', blob, filename);
  }

  formData.append('upload_preset', getUploadPreset());
  formData.append('folder', 'face-ranking');

  // Store subjectId and imageId in Cloudinary context metadata
  formData.append('context', `subjectId=${subjectId}|imageId=${imageId}`);

  // Also store as tags for easier querying and as fallback metadata
  formData.append('tags', `face-ranking,${subjectId},${imageId}`);

  const response = await fetch(`${getCloudinaryUrl()}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cloudinary upload failed: ${error}`);
  }

  return response.json();
}

/* ─── Extract metadata from Cloudinary resource ─── */
function extractMetadata(resource: Record<string, unknown>): { subjectId: string; imageId: string } {
  // Method 1: Try context.custom (set during upload)
  const context = resource.context as { custom?: Record<string, string> } | undefined;
  if (context?.custom?.subjectId && context?.custom?.imageId) {
    return {
      subjectId: context.custom.subjectId,
      imageId: context.custom.imageId,
    };
  }

  // Method 2: Try parsing from tags
  const tags = resource.tags as string[] | undefined;
  if (Array.isArray(tags) && tags.length >= 2) {
    // Tags are: ["face-ranking", "Sub_1", "Img_1"]
    const subTag = tags.find(t => t.startsWith('Sub_'));
    const imgTag = tags.find(t => t.startsWith('Img_'));
    if (subTag && imgTag) {
      return { subjectId: subTag, imageId: imgTag };
    }
  }

  // Method 3: Parse from public_id filename pattern: face-ranking/Sub_1_Img_1_timestamp
  const publicId = resource.public_id as string;
  const filename = publicId.split('/').pop() || ''; // e.g., "Sub_1_Img_1_1713500000000"
  const match = filename.match(/^(Sub_\d+)_(Img_\d+)/);
  if (match) {
    return { subjectId: match[1], imageId: match[2] };
  }

  // Method 4: No metadata found — assign sequential IDs based on index
  return { subjectId: 'Unsorted', imageId: 'Unknown' };
}

/* ─── List Images (using Cloudinary Admin API with Basic Auth) ─── */
export async function listImages(): Promise<FaceImage[]> {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    console.error('Cloudinary API key/secret not configured');
    return [];
  }

  // Build auth header: Basic base64(api_key:api_secret)
  const authString = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const params = new URLSearchParams({
    prefix: 'face-ranking',
    type: 'upload',
    max_results: '500',
    direction: 'asc',
  });

  const url = `${getCloudinaryUrl()}/resources/image/upload?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${authString}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Cloudinary list failed:', response.status, errorText);
    return [];
  }

  const data = await response.json();
  const resources = data.resources || [];

  return resources
    .map((r: Record<string, unknown>) => {
      const { subjectId, imageId } = extractMetadata(r);
      const publicId = r.public_id as string;

      return {
        id: publicId,
        subjectId,
        imageId,
        cloudinaryUrl: r.secure_url as string,
        publicId,
        createdAt: r.created_at as string,
      };
    })
    // Assign sequential Img_X IDs for unsorted images
    .map((img: FaceImage, idx: number) => {
      if (img.imageId === 'Unknown') {
        return { ...img, imageId: `Img_${idx + 1}` };
      }
      return img;
    })
    .sort((a: FaceImage, b: FaceImage) => {
      // Sort Unsorted to the end
      if (a.subjectId === 'Unsorted' && b.subjectId !== 'Unsorted') return 1;
      if (a.subjectId !== 'Unsorted' && b.subjectId === 'Unsorted') return -1;
      const subCompare = a.subjectId.localeCompare(b.subjectId);
      if (subCompare !== 0) return subCompare;
      return a.imageId.localeCompare(b.imageId, undefined, { numeric: true });
    });
}

/* ─── Delete Image (using Cloudinary Admin API with signature) ─── */
export async function deleteImage(publicId: string): Promise<boolean> {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    console.error('Cloudinary API key/secret not configured');
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Signature params must be sorted ALPHABETICALLY (public_id before timestamp)
  const signature = generateSignature(`public_id=${publicId}&timestamp=${timestamp}`);

  const formData = new FormData();
  formData.append('public_id', publicId);
  formData.append('timestamp', timestamp);
  formData.append('signature', signature);
  formData.append('api_key', apiKey);

  const response = await fetch(`${getCloudinaryUrl()}/resources/image/destroy`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Cloudinary delete failed:', response.status, errorText);
    return false;
  }

  const data = await response.json();
  return data.result === 'ok';
}

/* ─── Get Image URL with optional transformations ─── */
export function getCloudinaryImageUrl(publicId: string, transformations?: string): string {
  const base = `https://res.cloudinary.com/${getCloudName()}/image/upload`;
  if (transformations) {
    return `${base}/${transformations}/${publicId}`;
  }
  return `${base}/${publicId}`;
}
