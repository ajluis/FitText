# FitText Architecture

## Overview
FitText is an SMS-based fitness coaching app. Users text a phone number to log food, workouts, and weight. The app uses AI to parse natural language, track nutrition, and provide coaching.

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript 5.5
- **Framework**: Express 4.19
- **Database**: PostgreSQL via Prisma 5.22
- **Queue**: Redis via BullMQ 5.12 (reminders/scheduling)
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514)
- **SMS**: Sendblue API

## Directory Structure
```
src/
├── config/           # Environment config, constants
├── handlers/         # Message handlers by intent type
│   ├── index.ts      # Main router - handleInboundMessage()
│   ├── commands.ts   # Slash command handlers (/today, /help, etc)
│   ├── food-log.ts   # Food logging with AI parsing
│   ├── workout-log.ts
│   ├── weight-log.ts
│   ├── settings.ts   # Settings menu flow
│   ├── onboarding.ts # New user onboarding flow
│   ├── progress.ts   # Progress summaries
│   └── build.ts      # Build mode for code editing
├── services/
│   ├── message-router.ts  # Intent classification (regex + LLM)
│   ├── sendblue.ts        # SMS sending
│   ├── coaching-ai.ts     # Main coaching responses
│   ├── food-ai.ts         # Food parsing AI
│   ├── settings-ai.ts     # Natural language settings changes
│   ├── onboarding-ai.ts   # Onboarding AI
│   ├── scheduler.ts       # BullMQ reminder jobs
│   ├── build-tools.ts     # File/git operations for build mode
│   └── build-ai.ts        # Claude integration for build mode
├── lib/
│   ├── db.ts              # Prisma client
│   ├── claude.ts          # Anthropic client setup
│   ├── calculations.ts    # TDEE, macros, date helpers
│   └── retry.ts           # Retry logic with backoff
├── routes/
│   └── webhooks.ts        # Express routes for Sendblue webhooks
└── index.ts               # App entry point
```

## Message Flow
```
1. SMS received via POST /webhook/sendblue/inbound
2. webhooks.ts parses payload, calls handleInboundMessage()
3. handlers/index.ts:
   - Gets/creates user from DB
   - Checks modal states (onboarding, settings, build mode)
   - Calls classifyMessage() for intent detection
   - Routes to appropriate handler based on intent
4. Handler processes message, sends response via sendSMS()
```

## Intent Classification (message-router.ts)
Two-stage process:
1. **quickClassify()** - Fast regex patterns
   - Commands: `/settings`, `/today`, `/help`, etc
   - Weight: "183.5 lbs", "weighed in at 180"
   - Food keywords: "ate", "had", "breakfast", etc
   - Workout keywords: "gym", "ran", "lifted"
2. **llmClassify()** - Claude fallback for ambiguous messages

Intent types: `food_log`, `food_photo`, `workout_log`, `weight_log`, `command`, `settings_change`, `question`, `confirmation`, `correction`, `freeform`, `greeting`

## Key Database Models (prisma/schema.prisma)
- **User**: Profile, settings, targets, streaks
- **DailyLog**: Daily nutrition aggregates, flags for meals logged
- **FoodEntry**: Individual food logs with parsed items (JSON)
- **WorkoutEntry**: Exercise logs
- **WeightEntry**: Weight measurements
- **ConversationContext**: Tracks pending confirmations
- **OnboardingState**: Onboarding flow state
- **SettingsState**: Settings menu state
- **BuildSession**: Build mode conversation state

## Adding a New Command
1. Add to `COMMANDS` array in `src/services/message-router.ts`
2. Add `case` in `handleCommand()` in `src/handlers/commands.ts`
3. Implement handler function

Example:
```typescript
// message-router.ts
const COMMANDS = [..., '/mycommand'];

// commands.ts
case '/mycommand':
  const result = await getMyData(user);
  await sendSMS(user.phone, result);
  break;
```

## Adding a New Setting
1. Add pattern to `isSettingsRequest()` in `src/services/settings-ai.ts`
2. Add to `SettingsChangeSchema` enum
3. Add case in `applySettingsChange()`
4. Update LLM prompt with the new setting

## Key Patterns
- **sendSMS(phone, message)**: Send SMS response
- **prisma.user.findUnique()**: Get user data
- **getTodayDate(timezone)**: Get today's date in user's TZ
- **callClaudeWithRetry()**: Call Claude with retry logic

## Environment Variables
```
DATABASE_URL          # PostgreSQL connection
REDIS_URL             # Redis for BullMQ
SENDBLUE_API_KEY      # Sendblue credentials
SENDBLUE_API_SECRET
SENDBLUE_PHONE_NUMBER # App's phone number
ANTHROPIC_API_KEY     # Claude API
USDA_API_KEY          # Food database lookup
WEBHOOK_BASE_URL      # Public URL for webhooks
BUILD_ADMIN_PHONES    # Comma-separated admin phones for /build
GITHUB_TOKEN          # GitHub PAT for git operations
```

## Reminders System (scheduler.ts)
BullMQ jobs run on cron schedules:
- Every 15 min: Check meal reminders
- Every 30 min: Check daily summaries
- Daily 10am: Check inactive users
- Sunday 7pm: Weekly summaries

Reminders respect:
- `accountabilityLevel` (light/medium/high)
- `reminderBreakfastEnabled`, `reminderLunchEnabled`, `reminderDinnerEnabled`
- `remindersPaused` flag

## Food Logging Flow
1. User sends food description or photo
2. `handleFoodLog()` or `handleFoodPhoto()` called
3. AI parses food into items with calories/protein
4. Saves to pending confirmation in ConversationContext
5. User confirms or corrects
6. FoodEntry created, DailyLog updated

## Coaching Personalities
Users can set coaching style:
- `motivator`: High energy, celebrate everything
- `educator`: Teach the why, science-based
- `coach`: Professional, balanced (default)
- `friend`: Casual, conversational
