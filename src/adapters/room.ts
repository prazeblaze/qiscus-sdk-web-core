import { atom, Atom, lens } from 'derivable'
import { IQHttpAdapter } from './http'
import QUrlBuilder from '../utils/url-builder'
import {
  IQParticipant,
  IQRoom,
  IQRoomAdapter,
  IQRoomType,
  IQUserAdapter
} from '../defs'

export class QParticipant implements IQParticipant {
  id: number;
  avatarUrl: string;
  displayName: string;
  lastReadMessageId: number;
  lastReceivedMessageId: number;
  userId: string;

  updateFromJson(json: GetParticipantResponse.Participant): IQParticipant {
    this.id = json.id;
    this.avatarUrl = json.avatar_url;
    this.displayName = json.username;
    this.lastReadMessageId = json.last_comment_read_id;
    this.lastReceivedMessageId = json.last_comment_received_id;
    this.userId = json.email;
    return this;
  }

  static fromJson(json: GetParticipantResponse.Participant): IQParticipant {
    return new QParticipant().updateFromJson(json);
  }
}

interface QRoomJson {
  id: number;
  unique_id: string;
  room_name: string;
  avatar_url: string;
  is_public_channel: boolean;
  last_comment_message: string;
  last_comment_id: number;
  unread_count: number;
  participants: object[];
  room_total_participants: number;
  options: string;
  chat_type: string;
}

export class QRoom implements IQRoom {
  avatarUrl: string;
  isChannel: boolean;
  lastMessageContent?: string;
  lastMessageId?: number;
  type: IQRoomType;
  uniqueId: string;
  unreadCount: number;
  id: number;
  name: string;
  totalParticipants?: number;
  participants?: IQParticipant[];
  options?: string;

  updateFromJson(json: QRoomJson): IQRoom {
    this.avatarUrl = json.avatar_url;
    this.isChannel = json.is_public_channel;
    this.id = json.id;
    this.lastMessageContent = json.last_comment_message;
    this.lastMessageId = json.last_comment_id;
    this.name = json.room_name;
    this.uniqueId = json.unique_id;
    this.unreadCount = json.unread_count;
    if (json.participants != null) {
      this.participants = json.participants.map((it: any) =>
        QParticipant.fromJson(it)
      );
    }
    if (json.room_total_participants != null) {
      this.totalParticipants = json.room_total_participants;
    }
    if (json.options != null) this.options = json.options;
    if (json.chat_type === "single") this.type = IQRoomType.Single;
    if (json.chat_type === "group") this.type = IQRoomType.Group;

    return this;
  }
  static fromJson(json: QRoomJson): IQRoom {
    return new QRoom().updateFromJson(json);
  }

  static emptyRoom() {
    return QRoom.fromJson({
      avatar_url: "",
      is_public_channel: false,
      id: -1,
      last_comment_id: -1,
      last_comment_message: "",
      room_name: "",
      unique_id: "",
      unread_count: -1,
      participants: [],
      chat_type: "",
      options: "{}",
      room_total_participants: -1
    });
  }
}

export default function getRoomAdapter(
  http: Atom<IQHttpAdapter>,
  user: Atom<IQUserAdapter>
): IQRoomAdapter {
  const rooms = atom<{ [key: string]: IQRoom }>({});
  const getRoomDataWithId = (roomId: number) =>
    lens<IQRoom>({
      get() {
        return rooms.get()[roomId];
      },
      set(room) {
        rooms.update(rooms => {
          if (room != null) rooms[room.id] = room;
          return rooms;
        });
      }
    });
  const getRoomDataWithUniqueId = (roomUniqueId: string) =>
    lens<IQRoom>({
      get() {
        return Object.values(rooms.get()).find(
          it => it.uniqueId === roomUniqueId
        );
      },
      set(room) {
        rooms.update(rooms => {
          if (room != null) rooms[room.id] = room;
          return rooms;
        });
      }
    });
  return {
    get rooms() {
      return rooms;
    },
    get getRoomDataWithId() {
      return getRoomDataWithId;
    },
    get getRoomDataWithUniqueId() {
      return getRoomDataWithUniqueId;
    },
    async addParticipants(
      roomId: number,
      participantIds: string[]
    ): Promise<IQParticipant[]> {
      const data = new FormData();
      data.append("token", user.get().token.get());
      data.append("room_id", String(roomId));
      participantIds.forEach(id => data.append("emails[]", id));
      const resp = await http
        .get()
        .postFormData<AddParticipantsResponse.RootObject>(
          "add_room_participants",
          data
        );
      const participants = resp.results.participants_added.map(
        QParticipant.fromJson
      );

      getRoomDataWithId(roomId).update(room => {
        if (room == null) return room;
        room.participants = [...room.participants, ...participants];
        room.totalParticipants = room.participants.length;
        return room;
      });

      return participants;
    },
    async removeParticipants(
      roomId: number,
      participantIds: string[]
    ): Promise<IQParticipant[]> {
      const data = new FormData();
      data.append("token", user.get().token.get());
      data.append("room_id", String(roomId));
      participantIds.forEach(id => data.append("emails[]", id));
      const resp = await http
        .get()
        .postFormData<RemoveParticipantResponse.RootObject>(
          "remove_room_participants",
          data
        );
      const removedIds = resp.results.participants_removed;

      const roomLens = getRoomDataWithId(roomId);
      const room = roomLens.get();
      if (room != null) {
        const participants = removedIds
          .map(id => {
            return room.participants.find(it => it.userId === id);
          })
          .filter(it => it != null);
        roomLens.update(room => {
          if (room == null) return room;
          room.participants = room.participants.filter(it =>
            removedIds.includes(it.userId)
          );
          room.totalParticipants = room.participants.length;
          return room;
        });
        return participants;
      } else {
        return removedIds.map(id => {
          const p = new QParticipant();
          p.userId = id;
          return p;
        });
      }
    },
    async chatUser(
      userId: string,
      extras?: string
    ): Promise<IQRoom> {
      const resp = await http
        .get()
        .post<ChatUserResponse.RootObject>("get_or_create_room_with_target", {
          token: user.get().token.get(),
          emails: [userId],
          options: extras
        });
      const room = QRoom.fromJson(resp.results.room);
      getRoomDataWithId(room.id).update(it => ({ ...it, ...room }));
      return room;
    },
    async clearRoom(roomUniqueIds: string[]): Promise<IQRoom[]> {
      const url = QUrlBuilder("clear_room_messages")
        .param("token", user.get().token.get())
        .param("room_channel_ids", roomUniqueIds)
        .build();
      const resp = await http.get().delete<ClearRoomResponse.RootObject>(url);
      // TODO: Clear message related to this room unique id
      return resp.results.rooms.map((room: any) => QRoom.fromJson(room));
    },
    async createGroup(
      name: string,
      userIds: string[],
      avatarUrl?: string,
      extras?: string
    ): Promise<IQRoom> {
      const resp = await http
        .get()
        .post<CreateRoomResponse.RootObject>("create_room", {
          token: user.get().token.get(),
          name: name,
          participants: userIds,
          avatar_url: avatarUrl,
          options: extras
        });
      const room = QRoom.fromJson(resp.results.room);

      getRoomDataWithId(room.id).set(room);

      return room;
    },
    async getChannel(
      uniqueId: string,
      name?: string,
      avatarUrl?: string,
      extras?: string
    ): Promise<IQRoom> {
      const resp = await http
        .get()
        .post<GetChannelResponse.RootObject>(
          "get_or_create_room_with_unique_id",
          {
            token: user.get().token.get(),
            unique_id: uniqueId,
            name: name,
            avatar_url: avatarUrl,
            options: extras
          }
        );
      const room = QRoom.fromJson(resp.results.room);
      getRoomDataWithId(room.id).set(room);
      return room;
    },
    async getParticipantList(
      roomUniqueId: string,
      offset?: number | null,
      sorting?: "asc" | "desc" | null
    ): Promise<IQParticipant[]> {
      const url = QUrlBuilder("room_participants")
        .param("token", user.get().token.get())
        .param("offset", offset)
        .param("room_unique_id", roomUniqueId)
        .param('sorting', sorting)
        .build();
      const resp = await http.get().get<GetParticipantResponse.RootObject>(url);
      const participants = resp.results.participants.map(participant =>
        QParticipant.fromJson(participant)
      );

      // getRoomDataWithId(resp.results).update(room => {
      //   room.participants = participants;
      //   room.totalParticipants = room.participants.length;
      //   return room;
      // });

      return participants;
    },
    async getRoom(roomId: number): Promise<IQRoom> {
      const url = QUrlBuilder("get_room_by_id")
        .param("token", user.get().token.get())
        .param("id", roomId)
        .build();
      const resp = await http.get().get<GetRoomResponse.RootObject>(url);
      const room = QRoom.fromJson(resp.results.room);
      getRoomDataWithId(roomId).set(room);
      return room;
    },
    async getRoomInfo(
      roomIds?: number[],
      uniqueIds?: string[],
      page?: number,
      showRemoved: boolean = false,
      showParticipant: boolean = false
    ): Promise<IQRoom[]> {
      const data = new FormData();
      data.append("token", user.get().token.get());
      data.append("show_participants", String(showParticipant));
      data.append("show_removed", String(showRemoved));
      if (roomIds != null && roomIds.length > 0)
        roomIds.forEach(id => data.append("room_id[]", String(id)));
      if (uniqueIds != null && uniqueIds.length > 0)
        uniqueIds.forEach(id => data.append("room_unique_id[]", id));

      const resp = await http
        .get()
        .postFormData<GetRoomInfoResponse.RootObject>("rooms_info", data);
      const _rooms = resp.results.rooms_info.map(room =>
        QRoom.fromJson({
          ...room,
          last_comment_id: room.last_comment.id,
          last_comment_id_str: room.last_comment.id_str,
          last_topic_id: room.last_comment.topic_id,
          last_topic_id_str: room.last_comment.topic_id_str,
          last_comment_message: room.last_comment.message
        } as ChatUserResponse.Room)
      );

      rooms.update(rooms => {
        _rooms.forEach(room => (rooms[room.id] = room));
        return rooms;
      });

      return _rooms;
    },
    async getRoomList(
      showParticipant?: boolean,
      showRemoved?: boolean,
      showEmpty?: boolean,
      page?: number,
      limit?: number
    ): Promise<IQRoom[]> {
      const url = QUrlBuilder("user_rooms")
        .param("token", user.get().token.get())
        .param("page", page)
        .param("limit", limit)
        .param("show_participants", showParticipant)
        .param("show_removed", showRemoved)
        .param("show_empty", showEmpty)
        .build();
      const resp = await http.get().get<GetRoomListResponse.RootObject>(url);
      const _rooms = resp.results.rooms_info.map(it =>
        QRoom.fromJson({
          ...it,
          last_comment_message: it.last_comment.message,
          last_comment_id: it.last_comment.id
        } as QRoomJson)
      );
      rooms.update(rooms => {
        const rs = _rooms.reduce<{ [key: string]: IQRoom }>((res, room) => {
          res[room.id] = room;
          return res;
        }, {});
        return {
          ...rooms,
          ...rs
        };
      });
      return _rooms;
    },
    async getUnreadCount(): Promise<number> {
      const url = QUrlBuilder("total_unread_count")
        .param("token", user.get().token.get())
        .build();
      const resp = await http.get().get<GetUnreadResponse.RootObject>(url);
      return resp.results.total_unread_count;
    },
    async updateRoom(
      roomId: number,
      name?: string | null,
      avatarUrl?: string | null,
      extras?: string | null
    ): Promise<IQRoom> {
      const data = new FormData();
      data.append("token", user.get().token.get());
      data.append("id", String(roomId));
      if (name != null) {
        data.append("room_name", name);
      }
      if (avatarUrl != null) {
        data.append("avatar_url", avatarUrl);
      }
      if (extras != null) {
        data.append("options", extras);
      }

      const resp = await http
        .get()
        .postFormData<UpdateRoomResponse.RootObject>("update_room", data);
      const room = QRoom.fromJson(resp.results.room);
      getRoomDataWithId(roomId).set(room);
      return room;
    }
  };
}

//region Response Type
declare module AddParticipantsResponse {
  export interface Extras {}

  export interface ParticipantsAdded {
    avatar_url: string;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Results {
    participants_added: ParticipantsAdded[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module ChatUserResponse {
  export interface Participant {
    avatar_url: string;
    email: string;
    extras: object;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    last_comment_id: number;
    last_comment_id_str: string;
    last_comment_message: string;
    last_topic_id: number;
    last_topic_id_str: string;
    options: string;
    participants: Participant[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    comments: any[];
    room: Room;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module ClearRoomResponse {
  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    options: string;
    raw_room_name: string;
    room_name: string;
    unique_id: string;
    last_comment?: any;
  }

  export interface Results {
    rooms: Room[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module CreateRoomResponse {
  export interface Extras {
    role: string;
  }

  export interface Participant {
    avatar_url: string;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    last_comment_id: number;
    last_comment_id_str: string;
    last_comment_message: string;
    last_topic_id: number;
    last_topic_id_str: string;
    options: string;
    participants: Participant[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    comments: any[];
    room: Room;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetChannelResponse {
  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    last_comment_id: number;
    last_comment_id_str: string;
    last_comment_message: string;
    last_topic_id: number;
    last_topic_id_str: string;
    options: string;
    participants: any[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    changed: boolean;
    comments: any[];
    room: Room;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetParticipantResponse {
  export interface Meta {
    current_offset: number;
    per_page: number;
    total: number;
  }

  export interface Extras {}

  export interface Participant {
    avatar_url: string;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Results {
    meta: Meta;
    participants: Participant[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetRoomResponse {
  export interface Payload {}

  export interface Avatar {
    url: string;
  }

  export interface UserAvatar {
    avatar: Avatar;
  }

  export interface Comment {
    comment_before_id: number;
    comment_before_id_str: string;
    disable_link_preview: boolean;
    email: string;
    extras: object;
    id: number;
    id_str: string;
    is_deleted: boolean;
    is_public_channel: boolean;
    message: string;
    payload: Payload;
    room_avatar: string;
    room_id: number;
    room_id_str: string;
    room_name: string;
    room_type: string;
    status: string;
    timestamp: Date;
    topic_id: number;
    topic_id_str: string;
    type: string;
    unique_temp_id: string;
    unix_nano_timestamp: number;
    unix_timestamp: number;
    user_avatar: UserAvatar;
    user_avatar_url: string;
    user_id: number;
    user_id_str: string;
    username: string;
  }

  export interface Extras2 {
    role: string;
  }

  export interface Participant {
    avatar_url: string;
    email: string;
    extras: Extras2;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    last_comment_id: number;
    last_comment_id_str: string;
    last_comment_message: string;
    last_topic_id: number;
    last_topic_id_str: string;
    options: string;
    participants: Participant[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    comments: Comment[];
    room: Room;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetRoomInfoResponse {
  export interface Meta {
    request_rooms_total: number;
    response_rooms_total: number;
  }

  export interface Extras {}

  export interface Payload {}

  export interface Avatar {
    url: string;
  }

  export interface UserAvatar {
    avatar: Avatar;
  }

  export interface LastComment {
    comment_before_id: number;
    comment_before_id_str: string;
    disable_link_preview: boolean;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    is_deleted: boolean;
    is_public_channel: boolean;
    message: string;
    payload: Payload;
    room_avatar: string;
    room_id: number;
    room_id_str: string;
    room_name: string;
    room_type: string;
    status: string;
    timestamp: Date;
    topic_id: number;
    topic_id_str: string;
    type: string;
    unique_temp_id: string;
    unix_nano_timestamp: number;
    unix_timestamp: number;
    user_avatar: UserAvatar;
    user_avatar_url: string;
    user_id: number;
    user_id_str: string;
    username: string;
  }

  export interface Participant {
    avatar_url: string;
    email: string;
    extras: object;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface RoomsInfo {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    is_removed: boolean;
    last_comment: LastComment;
    options: string;
    participants: Participant[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    meta: Meta;
    rooms_info: RoomsInfo[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetRoomListResponse {
  export interface Meta {
    current_page: number;
    total_room: number;
  }

  export interface Extras {}

  export interface Payload {}

  export interface Avatar {
    url: string;
  }

  export interface UserAvatar {
    avatar: Avatar;
  }

  export interface LastComment {
    comment_before_id: number;
    comment_before_id_str: string;
    disable_link_preview: boolean;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    is_deleted: boolean;
    is_public_channel: boolean;
    message: string;
    payload: Payload;
    room_avatar: string;
    room_id: number;
    room_id_str: string;
    room_name: string;
    room_type: string;
    status: string;
    timestamp: Date;
    topic_id: number;
    topic_id_str: string;
    type: string;
    unique_temp_id: string;
    unix_nano_timestamp: any;
    unix_timestamp: number;
    user_avatar: UserAvatar;
    user_avatar_url: string;
    user_id: number;
    user_id_str: string;
    username: string;
  }

  export interface RoomsInfo {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    is_removed: boolean;
    last_comment: LastComment;
    options: string;
    raw_room_name: string;
    room_name: string;
    unique_id: string;
    unread_count: number;
    participants?: GetRoomInfoResponse.Participant[];
    room_total_participants?: number;
  }

  export interface Results {
    meta: Meta;
    rooms_info: RoomsInfo[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module GetUnreadResponse {
  export interface Results {
    total_unread_count: number;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module RemoveParticipantResponse {
  export interface Results {
    participants_removed: string[];
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
declare module UpdateRoomResponse {
  export interface Extras {
    role: string;
  }

  export interface Participant {
    avatar_url: string;
    email: string;
    extras: Extras;
    id: number;
    id_str: string;
    last_comment_read_id: number;
    last_comment_read_id_str: string;
    last_comment_received_id: number;
    last_comment_received_id_str: string;
    username: string;
  }

  export interface Room {
    avatar_url: string;
    chat_type: string;
    id: number;
    id_str: string;
    is_public_channel: boolean;
    last_comment_id: number;
    last_comment_id_str: string;
    last_comment_message: string;
    last_topic_id: number;
    last_topic_id_str: string;
    options: string;
    participants: Participant[];
    raw_room_name: string;
    room_name: string;
    room_total_participants: number;
    unique_id: string;
    unread_count: number;
  }

  export interface Results {
    changed: boolean;
    comments: any[];
    room: Room;
  }

  export interface RootObject {
    results: Results;
    status: number;
  }
}
//endregion