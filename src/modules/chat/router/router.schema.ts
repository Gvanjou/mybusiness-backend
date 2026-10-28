// Parts of a listing a user can ask about.
export const aspects = ['overview', 'price', 'risks', 'competition', 'missing', 'seller_questions', 'similar'] as const
export type Aspect = (typeof aspects)[number]
