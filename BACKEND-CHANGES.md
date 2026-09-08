# AptusHire Backend Change Report

Generated from the backend Git history on 2026-09-03.

## Scope and source of truth

This report compares every commit currently present in the backend repository:

| Commit | Date | Purpose |
| --- | --- | --- |
| `9ec652e` | 2026-09-02 20:07 IST | Initial AptusHire backend baseline |
| `8ab9a3e` | 2026-09-03 04:16 IST | Main backend update |
| `1c6e440` | 2026-09-03 15:14 IST | Candidate job-recommendation update |

The working tree was clean when this report was generated. The main update changed 31 files (`854` insertions and `789` deletions). The latest recommendation update changed 3 files (`115` insertions and `5` deletions). There is no history before the initial commit in this repository, so “all changes” here means everything after `9ec652e`.

## Executive summary

The backend gained six major capabilities:

1. Candidate login through Google Identity Services.
2. Candidate-owned application details, assessment results, and rejection reports.
3. A deterministic, versioned rejection-analysis system generated from ATS, assessment, and interview evidence.
4. Resume-library autofill support for both legacy `Resume` records and newer `ResumeVersion` records, including name, email, and phone extraction.
5. Replacement of S3/MinIO/local-disk persistence with Cloudinary-only storage.
6. Personalized dashboard job recommendations based on profile and resume signals.

## API changes

All routes below are new.

| Method and path | Access | Implementation | Purpose |
| --- | --- | --- | --- |
| `POST /api/auth/google` | Public, login rate limit | `routes/authRoutes.js`, `controllers/authController.js` | Verifies a Google ID token, creates or updates a candidate account, and returns normal access/refresh tokens. |
| `GET /api/candidate-dashboard/applications/:id` | Candidate | `routes/candidateDashboardRoutes.js`, `controllers/candidateDashboardController.js` | Returns an application only when its email belongs to the signed-in candidate. |
| `GET /api/candidate-dashboard/assessments/:id/result` | Candidate | Same files as above | Returns a completed assessment result, percentage score, and per-criterion performance for the owning candidate. |
| `GET /api/candidate-dashboard/applications/:id/rejection-report` | Candidate | Same route/controller plus rejection-report service | Returns the latest rejection analysis for the candidate’s own rejected application. |
| `GET /api/candidates/:id/rejection-report` | Admin | `routes/candidateRoutes.js`, `controllers/candidateController.js` | Returns the latest tenant-scoped rejection report for an application. |

Existing candidate application serialization now returns a limited nested job object with job ID, title, department, and company name instead of returning the populated job object unchanged.

## Detailed functional changes

### 1. Google candidate authentication

- Added Google ID-token verification using `google-auth-library`.
- Uses `GOOGLE_CLIENT_ID` as the token audience.
- Requires Google to provide a verified email and subject identifier.
- Creates missing users as verified `candidate` accounts and initializes their dashboard.
- Existing unverified candidate accounts become verified after successful Google login.
- Non-candidate accounts are denied candidate-portal access.
- Issues the backend’s existing access and refresh tokens and writes an `auth.google_login` audit event.

Locations:

- `controllers/authController.js`
- `routes/authRoutes.js`
- `package.json`
- `.env.example`

### 2. Candidate self-service data

- Candidates can retrieve their own application details, including sanitized stage history and non-empty offer information.
- Candidates can retrieve a completed assessment result only when the assessment belongs to one of their applications.
- Assessment criteria IDs are enriched with labels from the associated `RoleRubric`.
- Assessment results expose the overall percentage and per-criterion correct/total counts; unsupported narrative feedback is intentionally omitted.
- Assessment-session job population now includes company name, improving candidate dashboard data.

Locations:

- `controllers/candidateDashboardController.js`
- `routes/candidateDashboardRoutes.js`
- `utils/candidateSerializers.js`

### 3. Rejection reports

A new tenant-scoped `CandidateRejectionReport` model stores versioned analysis. Reports include:

- overall alignment values;
- prioritized rejection reasons;
- requirement-by-requirement evidence status;
- assessment and interview analysis;
- claim validation and skill gaps;
- improvement areas and a time-based improvement plan;
- reapplication readiness;
- source references and an evidence-confidence level.

The implementation is deterministic and derives its output from the saved candidate, job, ATS assessment, latest assessment session, and latest interview session. Missing assessment/interview evidence is reported as “Not Assessed” rather than inventing a score.

Generation is triggered asynchronously in two places:

- after the ATS completes when the candidate is already rejected;
- when the pipeline transitions a candidate to `rejected`.

The first generated report is reused unless the service is explicitly called with `force: true`; retrieval endpoints return the latest version and do not generate a missing report on demand.

Locations:

- `models/CandidateRejectionReport.js`
- `services/candidateRejectionReportService.js`
- `services/atsService.js`
- `services/pipelineService.js`
- `controllers/candidateController.js`
- `controllers/candidateDashboardController.js`
- `routes/candidateRoutes.js`
- `routes/candidateDashboardRoutes.js`
- `test/unit/candidateRejectionReport.test.js`

### 4. Resume selection and autofill

- The autofill endpoint now accepts either `resumeId` or `resumeVersionId`.
- Every lookup remains scoped to the signed-in candidate’s email.
- For a `ResumeVersion`, the backend tries to reuse a legacy `Resume` with the same checksum.
- If an older resume version lacks parsed text, the backend downloads the Cloudinary object, extracts text, calculates a SHA-256 text hash, and repairs the stored parsed snapshot.
- Autofill results can now be cached directly on `ResumeVersion`, preserving the selected version’s provenance.
- Basic-information extraction now covers `name`, `email`, and `phone` in addition to location and links.
- The autofill prompt/service version changed from `2026-07-31.1` to `2026-09-03.1`.

Locations:

- `controllers/candidateController.js`
- `models/ResumeVersion.js`
- `services/autofillService.js`
- `utils/autofillPrompts.js`

### 5. Cloudinary-only persistent storage

The storage provider was changed from S3/MinIO with local-disk fallback to Cloudinary only.

- Removed `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
- Added `cloudinary`.
- Replaced S3/local configuration with required Cloudinary credentials in production.
- Uploads are streamed from memory to Cloudinary.
- MongoDB stores an opaque `cloudinary:<base64url-json>` reference containing public ID, resource type, format, and secure URL.
- Downloads fetch the stored secure URL into a buffer; deletes call Cloudinary destroy.
- `getSignedDownloadUrl()` now returns the stored Cloudinary secure URL. Despite the retained function name, it does not create a new expiring signed URL.
- Local `uploads/` ignore rules were removed because local persistence is no longer used.
- `npm run check:storage` now performs Cloudinary upload, download, HTTPS URL, and delete checks.

Required variables:

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Removed storage variables:

```text
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_ENDPOINT
S3_REGION
S3_FORCE_PATH_STYLE
ALLOW_LOCAL_STORAGE
```

Operational impact:

- Existing database references pointing to S3 keys or local absolute paths are not understood by the new `decodeReference()` implementation. They require migration before affected files can be read or deleted.
- Cloudinary must be configured; there is no local development fallback in `storageService`.
- Download operations currently buffer the full remote object in backend memory.

Locations:

- `services/storageService.js`
- `scripts/checkStorage.js`
- `config/env.js`
- `.env.example`
- `.dockerignore`
- `.gitignore`
- `.nodemonignore`
- `middleware/upload.js`
- `package.json`
- `package-lock.json`

### 6. Interview recording changes

- Direct LiveKit participant Egress to S3 was removed.
- `startParticipantRecording()` now reports that Cloudinary uses the browser-recording pipeline.
- LiveKit Egress webhook completion no longer updates recording metadata.
- Recording playback compatibility now resolves Cloudinary references through storage service.
- Video enablement remains gated by persistent storage configuration.
- Demo interview placeholder storage was changed from a local upload path to a Cloudinary-style placeholder.

Locations:

- `services/livekitService.js`
- `models/InterviewSession.js`
- `routes/interviewSessionRoutes.js`
- `services/demoInterviewService.js`
- `scripts/_seedLiveKitE2E.js`
- `test/unit/livekitVideo.test.js`

### 7. Personalized job recommendations (latest commit)

- Dashboard recommendations now load up to 200 recent published, unapplied, unsaved jobs and rank them in memory.
- Candidate signals come from profile skills, experience skills, headline, biography, and the default/latest resume’s skills, tags, suggested roles, and experience years.
- Ranking combines required-skill coverage (60 points), shared domain words (25), experience eligibility (10), and recency (5).
- The response includes `recommendationScore` and normalized `matchedSkills` and returns the best five jobs.
- A `ResumeVersion` now counts toward profile resume completion even if no legacy `Resume` exists.

Locations:

- `utils/candidateRecommendations.js`
- `controllers/candidateDashboardController.js`
- `test/unit/candidateRecommendations.test.js`

Implementation note: `scoreJob()` builds job text that already contains every required skill, then treats a skill as matched when that same job text contains it. Consequently, required skills may be reported as matched even when absent from candidate signals. The domain-word portion still helps ordering, but `matchedSkills` and the 60-point skill component should be reviewed before treating the score as a true candidate/job match percentage.

## Complete changed-file index

### Main update: `9ec652e` to `8ab9a3e`

| File | Change |
| --- | --- |
| `.dockerignore` | Removed local upload exclusion; updated Cloudinary comment. |
| `.env.example` | Added Google client ID and Cloudinary variables; removed S3/local variables; revised recording documentation. |
| `.gitignore` | Stopped ignoring `uploads/`. |
| `.nodemonignore` | Removed `uploads/**`. |
| `config/env.js` | Replaced production S3/local validation with Cloudinary credential validation. |
| `controllers/authController.js` | Added Google login/account provisioning/token issuance. |
| `controllers/candidateController.js` | Added ResumeVersion autofill support and admin rejection-report retrieval. |
| `controllers/candidateDashboardController.js` | Added candidate-owned application, result, and rejection-report handlers. |
| `middleware/upload.js` | Updated persistence assumptions to Cloudinary. |
| `models/CandidateRejectionReport.js` | Added new versioned tenant-scoped report model and indexes. |
| `models/InterviewSession.js` | Updated recording URL/storage description. |
| `models/ResumeVersion.js` | Added autofill cache field. |
| `package-lock.json` | Re-resolved dependencies for Cloudinary/Google and removed AWS SDK packages. |
| `package.json` | Added Cloudinary and Google auth libraries; removed AWS S3 libraries. |
| `routes/authRoutes.js` | Added Google login endpoint. |
| `routes/candidateDashboardRoutes.js` | Added three candidate self-service endpoints. |
| `routes/candidateRoutes.js` | Added admin rejection-report endpoint. |
| `routes/interviewSessionRoutes.js` | Updated recording endpoint description. |
| `scripts/_seedLiveKitE2E.js` | Updated storage-dependent seed behavior/configuration. |
| `scripts/checkStorage.js` | Replaced S3/local checks with Cloudinary round-trip verification. |
| `services/atsService.js` | Triggers a rejection report when ATS leaves an application rejected. |
| `services/autofillService.js` | Added contact extraction and updated autofill version. |
| `services/candidateRejectionReportService.js` | Added deterministic report construction, generation, versioning, and retrieval. |
| `services/demoInterviewService.js` | Changed demo resume placeholder away from local uploads. |
| `services/livekitService.js` | Removed S3 Egress recording and aligned playback with Cloudinary/browser recording. |
| `services/pipelineService.js` | Triggers a report on transition to rejected. |
| `services/storageService.js` | Replaced S3/local implementation with Cloudinary. |
| `test/unit/candidateRejectionReport.test.js` | Added threshold, weak-evidence, and missing-evidence tests. |
| `test/unit/livekitVideo.test.js` | Updated storage gating expectations for Cloudinary. |
| `utils/autofillPrompts.js` | Added name/email/phone schema and bumped prompt version. |
| `utils/candidateSerializers.js` | Restricted/enriched serialized job summary. |

### Latest update: `8ab9a3e` to `1c6e440`

| File | Change |
| --- | --- |
| `controllers/candidateDashboardController.js` | Uses ResumeVersion data, personalized ranking, and company-populated assessment jobs. |
| `utils/candidateRecommendations.js` | Added signal extraction and in-memory job scoring/ranking. |
| `test/unit/candidateRecommendations.test.js` | Added profile-skill and default-resume recommendation tests. |

## Deployment checklist

1. Set `GOOGLE_CLIENT_ID` to the same OAuth web client ID used by the candidate frontend.
2. Set all three Cloudinary credentials.
3. Run `npm install` or `npm ci` so Cloudinary and Google auth dependencies are installed and AWS SDK packages are removed.
4. Run `npm run check:env`.
5. Run `npm run check:storage` against the intended Cloudinary account.
6. Migrate existing S3/local file references to valid Cloudinary references before deploying this version over an existing database.
7. Confirm the browser interview-recording upload/finalization path is enabled if interview video is required; LiveKit Egress no longer supplies it.
8. Run `npm test`.

## Verification performed for this report

- The 11 directly affected recommendation, rejection-report, and LiveKit video tests pass.
- On Windows, the current `npm test` script does not discover files because the quoted `test/unit/*.test.js` glob is passed literally to Node. This is a test-runner portability issue, not a test assertion failure. The affected tests were verified by passing their paths directly to `node --test`.
