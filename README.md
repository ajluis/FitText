# FitText

SMS-based fitness and nutrition coaching system. Track food, log workouts, and stay accountable — all through text messages.

## Features

- **Food Logging**: Text what you eat or send a photo for automatic macro estimation
- **Workout Tracking**: Log workouts with optional detailed exercise tracking (sets/reps/weight)
- **Weight Tracking**: Simple weight logging with trend analysis
- **Smart Reminders**: Customizable meal reminders, daily summaries, and weekly check-ins
- **Progress Tracking**: View calories, protein, workout stats, and weight trends
- **AI Coaching**: Context-aware responses based on your goals and patterns
- **Streak System**: Stay motivated with logging streaks and milestones

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL + Prisma ORM
- **Job Queue**: BullMQ + Redis
- **SMS**: Sendblue
- **AI**: Anthropic Claude (chat + vision)
- **Nutrition Data**: USDA FoodData Central

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL database
- Redis instance
- Sendblue account with API credentials
- Anthropic API key
- USDA API key

### Installation

1. Clone the repository:
```bash
git clone <repo-url>
cd fittext
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. Set up the database:
```bash
npm run db:generate
npm run db:push
```

5. Start the development server:
```bash
npm run dev
```

### Environment Variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/fittext"
REDIS_URL="redis://localhost:6379"
SENDBLUE_API_KEY="your-sendblue-api-key"
SENDBLUE_API_SECRET="your-sendblue-api-secret"
ANTHROPIC_API_KEY="your-anthropic-api-key"
USDA_API_KEY="your-usda-api-key"
PORT=3000
WEBHOOK_BASE_URL="https://your-domain.com"
```

## Webhook Setup

Configure Sendblue to send inbound messages to:
```
POST https://your-domain.com/webhook/sendblue/inbound
```

## Commands

Users can text these commands:

| Command | Description |
|---------|-------------|
| `/settings` | Open settings menu |
| `/progress` | View progress summary |
| `/today` | View today's log |
| `/week` | View weekly summary |
| `/help` | Show available commands |
| `/pause` | Pause reminders |
| `/resume` | Resume reminders |

## Usage Examples

### Logging Food
```
User: "Had 2 eggs and toast for breakfast"
Bot: "Got it! Logged for breakfast:
• Eggs (2) — 140 cal, 12g protein
• Toast (1 slice) — 80 cal, 3g protein

Total: 220 cal, 15g protein

Today so far: 220 / 2,000 cal | 15 / 180g protein"
```

### Logging Workouts
```
User: "Bench 135x10, 155x8, 175x6. Rows 135 3x10"
Bot: "💪 Logged:
• Bench Press: 135×10, 155×8, 175×6
• Barbell Rows: 135×10 ×3 sets

Total volume: 5,530 lbs

This week: 3/4 workouts"
```

### Photo Logging
```
User: [sends food photo]
Bot: "Here's what I see:
• Grilled chicken (~6oz) — 280 cal, 52g protein
• Rice (~1 cup) — 205 cal, 4g protein

Total: ~485 cal, 56g protein

Is that right? Reply 'yes' to log, or tell me what's different."
```

## Project Structure

```
src/
├── config/           # Configuration and environment
├── handlers/         # Message handlers by intent
│   ├── onboarding.ts # New user onboarding flow
│   ├── food-log.ts   # Food logging (text + photo)
│   ├── workout-log.ts# Workout logging
│   ├── weight-log.ts # Weight tracking
│   ├── settings.ts   # Settings menu navigation
│   ├── commands.ts   # Slash command handlers
│   ├── progress.ts   # Progress tracking
│   └── index.ts      # Main message router
├── lib/              # Shared utilities
│   ├── db.ts         # Prisma client
│   ├── redis.ts      # Redis client
│   ├── claude.ts     # Anthropic client
│   ├── usda.ts       # USDA API client
│   └── calculations.ts# TDEE, parsing, etc.
├── routes/           # Express routes
│   └── webhooks.ts   # Sendblue webhooks
├── services/         # Business logic
│   ├── sendblue.ts   # SMS sending
│   ├── message-router.ts # Intent classification
│   ├── scheduler.ts  # Reminders & summaries
│   └── coaching-ai.ts# AI responses
├── prisma/
│   └── schema.prisma # Database schema
└── index.ts          # Entry point
```

## Database Schema

Key models:
- **User**: Profile, goals, targets, preferences
- **DailyLog**: Daily nutrition/workout aggregates
- **FoodEntry**: Individual food logs
- **WorkoutEntry**: Workout sessions
- **WeightEntry**: Weight measurements
- **Reminder**: Scheduled reminders

## Accountability Levels

| Level | Features |
|-------|----------|
| Light | Daily summary only |
| Medium | Meal reminders if not logged, weigh-in reminders |
| High | All reminders + morning/evening check-ins |

## Development

```bash
# Run development server with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Database commands
npm run db:generate  # Generate Prisma client
npm run db:push      # Push schema to database
npm run db:migrate   # Create migration
npm run db:studio    # Open Prisma Studio
```

## License

MIT
