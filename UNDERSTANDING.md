# FitText Repository Understanding

## Project Overview

FitText is an **SMS-based fitness and nutrition coaching system** that enables users to track their health, fitness progress, and nutrition entirely through text messages. It provides a conversational AI-powered coach accessible via simple SMS commands.

### Key Value Proposition
- No app downloads required - works on any phone with SMS
- Natural language interaction for logging meals, workouts, and weight
- AI-powered food photo analysis for automatic macro estimation
- Personalized coaching based on user goals and patterns

---

## Core Features

### Food Logging
- **Text-based**: Describe meals in natural language (e.g., "Had 2 eggs and toast for breakfast")
- **Photo-based**: Send food photos for automatic macro estimation using Claude Vision
- **Confidence scoring**: System asks for confirmation when uncertain
- **Meal type detection**: Automatically categorizes as breakfast, lunch, dinner, or snack

### Workout Tracking
- **Strength training**: Log sets, reps, and weight (e.g., "Bench 135x10, 155x8")
- **Cardio**: Track distance and time
- **Exercise aliases**: Normalizes names (e.g., "bench" becomes "Bench Press")
- **Volume calculation**: Tracks total volume and estimated calories burned

### Weight Monitoring
- Track weight measurements with trend analysis
- Progress insights over time
- Weekly averages and goal tracking

### Smart Reminders
- **Meal reminders**: Configurable for breakfast, lunch, dinner
- **Daily summaries**: End-of-day nutrition recap
- **Weekly check-ins**: Progress review and goal adjustment
- **Inactivity detection**: Gentle nudges when logging lapses

### AI Coaching
- Context-aware responses based on user goals
- Goal types: Fat loss, muscle gain, body recomp, general health
- Progress-focused feedback (avoids shame/guilt messaging)
- SMS-friendly responses (under 300 characters when possible)

### Streak System
- Tracks consecutive logging days
- Milestone celebrations at 7, 14, 21, 30, 50, 100 days
- Total days logged tracking

### Accountability Levels
- **Light**: Daily summary only
- **Medium**: Reminders + weigh-ins
- **High**: All reminders + weekly check-ins

---

## Technical Architecture

### Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ with TypeScript |
| Framework | Express.js |
| Database | PostgreSQL with Prisma ORM |
| Job Queue | BullMQ + Redis |
| SMS Delivery | Sendblue API |
| AI/Vision | Anthropic Claude |
| Nutrition Data | USDA FoodData Central API |
| Validation | Zod |

### Repository Structure

```
src/
├── config/                    # Environment & configuration
├── handlers/                  # Message intent handlers
│   ├── food-log.ts           # Food logging (text + photo)
│   ├── workout-log.ts        # Workout logging
│   ├── weight-log.ts         # Weight tracking
│   ├── settings.ts           # Settings menu
│   ├── progress.ts           # Progress tracking
│   ├── commands.ts           # Slash command handlers
│   ├── onboarding.ts         # New user setup
│   └── index.ts              # Main message router
├── lib/                       # Shared utilities
│   ├── db.ts                 # Prisma client
│   ├── redis.ts              # Redis client
│   ├── claude.ts             # Anthropic Claude client
│   ├── usda.ts               # USDA nutrition API
│   └── calculations.ts       # TDEE, parsing utilities
├── routes/                    # Express routes
│   └── webhooks.ts           # Sendblue SMS webhooks
├── services/                  # Business logic
│   ├── sendblue.ts           # SMS sending
│   ├── message-router.ts     # Intent classification
│   ├── scheduler.ts          # Job queue (reminders/summaries)
│   └── coaching-ai.ts        # AI responses
└── index.ts                  # Express server entry point
```

### Database Models

| Model | Purpose |
|-------|---------|
| User | Goals, targets, preferences, streak info |
| DailyLog | Daily nutrition/workout aggregates |
| FoodEntry | Individual food logs with confidence |
| WorkoutEntry | Exercise sessions |
| WeightEntry | Weight measurements |
| Reminder | Scheduled notifications |
| ConversationContext | Pending entries & context |

---

## Message Flow

```
1. User sends SMS
       ↓
2. Sendblue webhook receives inbound message
       ↓
3. handleInboundMessage() processes the message
       ↓
4. Intent Classification:
   - Fast pattern matching (regex) for ~80% of messages
   - Claude LLM fallback for ambiguous messages
       ↓
5. Route to appropriate handler based on intent
       ↓
6. Process action (log food, workout, weight, etc.)
       ↓
7. Send SMS response via Sendblue
```

### Intent Types
- `food_log` - Text-based food logging
- `food_photo` - Photo-based food logging
- `workout_log` - Exercise logging
- `weight_log` - Weight recording
- `command` - Slash commands
- `question` - User questions
- `confirmation` - Yes/no responses
- `correction` - Modifying previous entries
- `freeform` - General conversation
- `greeting` - Hello/hi messages

---

## Usage Examples

### Food Logging (Text)
```
User: "Had 2 eggs and toast for breakfast"

Bot: "Got it! Logged for breakfast:
• Eggs (2) — 140 cal, 12g protein
• Toast (1 slice) — 80 cal, 3g protein

Total: 220 cal, 15g protein
Today so far: 220 / 2,000 cal | 15 / 180g protein"
```

### Food Logging (Photo)
```
User: [sends food photo]

Bot: "Here's what I see:
• Grilled chicken (~6oz) — 280 cal, 52g protein
• Rice (~1 cup) — 205 cal, 4g protein

Total: ~485 cal, 56g protein

Is that right? Reply 'yes' to log, or tell me what's different."
```

### Workout Logging
```
User: "Bench 135x10, 155x8, 175x6. Rows 135 3x10"

Bot: "Logged:
• Bench Press: 135x10, 155x8, 175x6
• Barbell Rows: 135x10 x3 sets

Total volume: 5,530 lbs
This week: 3/4 workouts"
```

### Weight Logging
```
User: "175.2"

Bot: "Logged 175.2 lbs
7-day avg: 176.1 lbs (-0.9)
Trend: Down 2.3 lbs this month"
```

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `/settings` | Open settings menu |
| `/progress` | View progress summary |
| `/today` | View today's log |
| `/week` | View weekly summary |
| `/help` | Show available commands |
| `/pause` | Pause reminders |
| `/resume` | Resume reminders |

---

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | 0.27.0 | Claude API integration |
| `@prisma/client` | 5.19.0 | Database ORM |
| `express` | 4.19.2 | Web framework |
| `bullmq` | 5.12.0 | Job queue for scheduling |
| `ioredis` | 5.4.1 | Redis client |
| `zod` | 3.23.8 | Runtime type validation |
| `typescript` | 5.5.4 | Language |

---

## Development Notes

### Key Design Decisions
1. **SMS-first approach**: Designed for accessibility - no app required
2. **Hybrid intent classification**: Fast regex patterns with LLM fallback
3. **Confidence-based confirmation**: Asks for verification on uncertain parses
4. **Context tracking**: Maintains conversation state for follow-ups
5. **Timezone-aware**: All scheduling respects user timezone

### Coaching Philosophy
- Progress-focused, not perfection-focused
- Avoids shame/guilt messaging
- Celebrates consistency over intensity
- Personalized based on user goals
