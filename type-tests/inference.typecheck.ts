import {
  defineCollection,
  defineDocument,
  defineSchema,
  defineSubmission,
  s,
  type DefinitionType,
  type InferDefinition,
  type InferSubmission,
  type InferSchemaTypes,
  MONACO_STRUCTURE_TYPES,
} from "../src";

const schema = defineSchema({
  definitions: {
    settings: defineDocument({
      fields: {
        theme: s.string(),
        seo: s.object({
          optional: true,
          fields: {
            title: s.string({ optional: true }),
          },
        }),
      },
    }),
    posts: defineCollection({
      fields: {
        title: s.string(),
        body: s.markdown(),
        seo: s.object({
          optional: true,
          fields: {
            tags: s.array({
              optional: true,
              items: s.string(),
            }),
          },
        }),
      },
      systemFields: {
        slug: {
          enabled: true,
          source: "title",
        },
      },
    }),
  },
  submissions: {
    contact: defineSubmission({
      fields: {
        name: s.string(),
        email: s.email(),
        resume: s.file({ optional: true }),
        gallery: s.gallery({ optional: true }),
      },
      captcha: {
        required: true,
        provider: "hcaptcha",
      },
    }),
  },
});

type PostViaHelper = InferDefinition<"posts", typeof schema>;
type PostViaLegacy = DefinitionType<typeof schema.definitions.posts>;
type ContactSubmission = InferSubmission<"contact", typeof schema>;
type SchemaTypes = InferSchemaTypes<typeof schema>;

const post: PostViaHelper = {
  title: "Hello",
  body: "# Hello",
  slug: "hello",
  seo: {
    tags: ["launch"],
  },
};

const samePost: PostViaLegacy = post;
const mappedPost: SchemaTypes["posts"] = post;

const settings: SchemaTypes["settings"] = {
  theme: "daybreak",
};

const contact: ContactSubmission = {
  name: "Ada",
  email: "ada@example.com",
  resume: {
    arrayBuffer: async () => new ArrayBuffer(0),
    type: "application/pdf",
  },
  gallery: [
    {
      file: {
        arrayBuffer: async () => new ArrayBuffer(0),
        type: "image/png",
      },
      alt: "Screenshot",
    },
  ],
};

// @ts-expect-error body is required for posts
const missingBody: PostViaHelper = {
  title: "Oops",
  slug: "oops",
};

const wrongNestedType: SchemaTypes["posts"] = {
  title: "Oops",
  body: "# Hello",
  slug: "oops",
  seo: {
    // @ts-expect-error tags must be a string array
    tags: [123],
  },
};

// @ts-expect-error unknown definitions resolve to never
const missingDefinition: InferDefinition<"missing", typeof schema> = {};

const editorTypes: string = MONACO_STRUCTURE_TYPES;

void samePost;
void mappedPost;
void settings;
void contact;
void missingBody;
void wrongNestedType;
void missingDefinition;
void editorTypes;
