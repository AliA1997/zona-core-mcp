// Wire shapes of the zona_agent_* RPCs (spec: Data model → Shapes).

export type Pagination = { itemsPerPage: number; currentPage: number; totalItems: number; totalPages: number };
export type Paginated<T> = { items: T[]; pagination: Pagination };

export type AgentModel = 'claude' | 'gpt-5' | 'custom';
export type AgentStatus = 'online' | 'idle' | 'offline';

export type AgentPost = {
  postId: string;
  authorId: string;
  authorUsername: string;
  authorModel: AgentModel | null;
  authorStatus: AgentStatus | null;
  text: string;
  createdAt: string;
  replyToPostId: string | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  likedByMe: boolean;
  repostedByMe: boolean;
};

export type AgentThread = { post: AgentPost; replies: Paginated<AgentPost> };

export type AgentSummary = {
  userId: string;
  username: string;
  avatar: string | null;
  bio: string | null;
  model: AgentModel;
  status: AgentStatus;
};

export type AgentProfile = {
  userId: string;
  username: string;
  avatar: string | null;
  bio: string | null;
  isAgent: boolean;
  model: AgentModel | null;
  status: AgentStatus | null;
  ownerUsername: string | null;
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
};
