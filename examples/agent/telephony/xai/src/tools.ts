import {
  searchNewsTopic,
  getTrendingNews,
  getUserPosts,
  getMyFollowing,
  sendDM,
  postTweet,
  lookupUserByUsername
} from './x-api';
import { getCallContext, UserContext } from './user-auth';
import log from './logger';

export type ToolName =
  | 'search_news_topic'
  | 'get_trending_news'
  | 'get_user_posts'
  | 'get_my_following'
  | 'send_dm'
  | 'post_tweet';

interface SearchNewsTopicArgs {
  topic: string;
}

interface GetTrendingNewsArgs {
  country?: string;
}

interface GetUserPostsArgs {
  username: string;
}

interface GetMyFollowingArgs {
  // No args needed - uses caller's auth
}

interface SendDMArgs {
  recipient_username: string;
  message: string;
}

interface PostTweetArgs {
  text: string;
}

type ToolCallArgs =
  | SearchNewsTopicArgs
  | GetTrendingNewsArgs
  | GetUserPostsArgs
  | GetMyFollowingArgs
  | SendDMArgs
  | PostTweetArgs;

/**
 * Execute a tool call and return the result
 */
export async function executeToolCall(
  callId: string,
  toolName: ToolName,
  args: ToolCallArgs
): Promise<string> {
  log.app.info(`[${callId}] 🔧 Executing tool: ${toolName}`);
  log.app.info(`[${callId}]    Arguments: ${JSON.stringify(args)}`);

  // Get user context for this call (may have OAuth tokens)
  const userContext = getCallContext(callId);

  try {
    let result: string;

    switch (toolName) {
      case 'search_news_topic':
        const searchArgs = args as SearchNewsTopicArgs;
        result = await searchNewsTopic(searchArgs.topic);
        break;

      case 'get_trending_news':
        const trendArgs = args as GetTrendingNewsArgs;
        result = await getTrendingNews(trendArgs.country || 'US');
        break;

      case 'get_user_posts':
        const userArgs = args as GetUserPostsArgs;
        result = await getUserPosts(userArgs.username);
        break;

      // User-context tools (require OAuth authentication)
      case 'get_my_following':
        result = await handleGetMyFollowing(callId, userContext);
        break;

      case 'send_dm':
        const dmArgs = args as SendDMArgs;
        result = await handleSendDM(callId, userContext, dmArgs);
        break;

      case 'post_tweet':
        const tweetArgs = args as PostTweetArgs;
        result = await handlePostTweet(callId, userContext, tweetArgs);
        break;

      default:
        result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }

    log.app.info(`[${callId}] ✅ Tool completed: ${toolName}`);

    // Log a preview of the result (first 200 chars)
    const preview = result.length > 200 ? result.substring(0, 200) + '...' : result;
    log.app.info(`[${callId}]    Result preview: ${preview}`);

    return result;
  } catch (error) {
    log.app.error(`[${callId}] ❌ Tool failed: ${toolName}`, error);
    return JSON.stringify({
      success: false,
      error: `Tool execution failed: ${error}`
    });
  }
}

// ========================================
// User-Context Tool Handlers
// ========================================

async function handleGetMyFollowing(
  callId: string,
  userContext: UserContext | undefined
): Promise<string> {
  if (!userContext?.auth.authenticated || !userContext.auth.access_token) {
    return JSON.stringify({
      success: false,
      message: 'You need to connect your X account first. Visit our website to log in with X, then call back.',
      users: []
    });
  }

  return await getMyFollowing(
    userContext.auth.access_token,
    userContext.auth.x_user_id!
  );
}

async function handleSendDM(
  callId: string,
  userContext: UserContext | undefined,
  args: SendDMArgs
): Promise<string> {
  if (!userContext?.auth.authenticated || !userContext.auth.access_token) {
    return JSON.stringify({
      success: false,
      message: 'You need to connect your X account first. Visit our website to log in with X, then call back.'
    });
  }

  // Look up the recipient's user ID
  const recipient = await lookupUserByUsername(
    userContext.auth.access_token,
    args.recipient_username
  );

  if (!recipient) {
    return JSON.stringify({
      success: false,
      message: `Could not find user @${args.recipient_username}. Please check the username and try again.`
    });
  }

  log.app.info(`[${callId}] Sending DM to @${recipient.username} (${recipient.id})`);

  return await sendDM(
    userContext.auth.access_token,
    recipient.id,
    args.message
  );
}

async function handlePostTweet(
  callId: string,
  userContext: UserContext | undefined,
  args: PostTweetArgs
): Promise<string> {
  if (!userContext?.auth.authenticated || !userContext.auth.access_token) {
    return JSON.stringify({
      success: false,
      message: 'You need to connect your X account first. Visit our website to log in with X, then call back.'
    });
  }

  // Validate tweet length
  if (args.text.length > 280) {
    return JSON.stringify({
      success: false,
      message: `Your tweet is ${args.text.length} characters, but the maximum is 280. Please shorten it.`
    });
  }

  log.app.info(`[${callId}] Posting tweet for @${userContext.auth.x_username}`);

  return await postTweet(userContext.auth.access_token, args.text);
}
